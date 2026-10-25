import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginManifest } from '@musicfs/plugin-api';
import type { WorkerModule } from '../src/hosts/worker/publisher';
import { buildWorkerUpgrade } from '../scripts/build-worker-upgrade';
import { prepareWorkerDeployment } from '../scripts/deploy-worker';

test('a core/WebUI upgrade keeps the live registry, exact plugin revisions, typed modules and deployment configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-worker-upgrade-'));
  try {
    const previous = join(directory, 'previous'); const out = join(directory, 'upgrade');
    await mkdir(previous);
    const config = { name: 'musicfs-fixture', account_id: 'fixture-account', main: 'worker.mjs', no_bundle: true,
      find_additional_modules: true, compatibility_date: '2026-07-30', compatibility_flags: ['nodejs_compat'],
      triggers: { crons: [] }, workers_dev: true, preview_urls: false, limits: { cpu_ms: 100 }, observability: { enabled: false },
      assets: { directory: './old-web', binding: 'ASSETS', run_worker_first: ['/api/*', '/dav', '/dav/*'] },
      d1_databases: [{ binding: 'DB', database_name: 'fixture-db', database_id: 'retained-d1', migrations_dir: 'migrations' }],
      kv_namespaces: [{ binding: 'EXTRA', id: 'retained-kv' }],
      vars: { CF_ACCOUNT_ID: 'fixture-account', CF_WORKER_NAME: 'musicfs-fixture', EXTRA: 'retained' },
      rules: [{ type: 'ESModule', globs: ['**/*.js'], fallthrough: false }] };
    const configPath = join(previous, 'wrangler.jsonc');
    // Exercise the existing JSONC parser, including comments and a trailing comma.
    const configText = '// Existing configured target\n' + JSON.stringify(config, null, 2).replace(/\n}$/, ',\n}\n');
    await Bun.write(configPath, configText);
    const encoder = new TextEncoder();
    const module = (name: string, type: WorkerModule['type'], text: string): WorkerModule => ({ name, type, bytes: encoder.encode(text) });
    const revisions = ['a'.repeat(64), 'b'.repeat(64)];
    const manifests: PluginManifest[] = revisions.map((_, i) => ({ formatVersion: 1, id: 'org.musicfs.upgrade-fixture', name: '升级夹具',
      version: `${i + 1}.0.0`, apiRange: '>=0.1.3 <0.2.0', configVersion: 1, stateVersion: 1,
      hosts: { worker: 'index.mjs' }, files: ['index.mjs', 'audio.bin'] }));
    const registry = `// MusicFS change retained-operation\nexport const registrations = [${revisions.map((revision, i) =>
      `{id:${JSON.stringify(manifests[i]!.id)},revision:${JSON.stringify(revision)}}`).join(',')}];\n`;
    const modules: WorkerModule[] = [module('worker.mjs', 'esm', 'old entry'), module('core.mjs', 'esm', 'old core'),
      module('registry.mjs', 'esm', registry), module('retained/control.txt', 'text', 'extra module\n')];
    for (const [i, revision] of revisions.entries()) {
      modules.push(module(`plugins/${revision}/manifest.json`, 'text', JSON.stringify(manifests[i])),
        module(`plugins/${revision}/index.mjs`, 'esm', 'throw new Error("Assembly must never execute a plugin");'),
        { name: `plugins/${revision}/audio.bin`, type: 'data', bytes: new Uint8Array([0, 255, 10, i]) });
    }
    let gets = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.method).toBe('GET');
      expect(new URL(request.url).pathname).toBe('/client/v4/accounts/fixture-account/workers/scripts/musicfs-fixture/content/v2');
      expect(request.headers.get('authorization')).toBe('Bearer fixture-token'); gets++;
      const form = new FormData(); form.set('metadata', JSON.stringify({ main_module: 'worker.mjs' }));
      for (const item of modules) form.set(item.name, new File([item.bytes.slice().buffer], item.name,
        { type: item.type === 'esm' ? 'application/javascript+module' : item.type === 'text' ? 'text/plain' : 'application/octet-stream' }));
      const response = new Response(form); response.headers.set('cf-worker-main-module-part', 'worker.mjs');
      response.headers.set('content-type', response.headers.get('content-type')!.replace('multipart/form-data', 'multipart/mixed'));
      return response;
    }) as typeof fetch;
    const bundle = await buildWorkerUpgrade({ config: configPath, out, apiToken: 'fixture-token', fetcher });
    expect(gets).toBe(1);
    expect(await Bun.file(configPath).text()).toBe(configText);
    const core = await Bun.file(join(out, 'core.mjs')).text();
    expect(core).not.toBeEmpty(); expect(core).not.toBe('old core');
    expect(await Bun.file(join(out, 'worker.mjs')).text()).not.toBe('old entry');
    const retained = modules.filter(item => item.name !== 'worker.mjs' && item.name !== 'core.mjs');
    for (const item of retained) {
      expect(new Uint8Array(await Bun.file(join(out, item.name)).arrayBuffer())).toEqual(new Uint8Array(item.bytes));
      expect(bundle.modules.find(module => module.name === item.name)).toEqual({ name: item.name, file: item.name, type: item.type });
    }
    expect(bundle.plugins).toEqual(manifests.map((manifest, i) => ({ manifest, revision: revisions[i]! })));
    expect(bundle.identity.plugins).toEqual(manifests.map((manifest, i) => ({ id: manifest.id, version: manifest.version, revision: revisions[i]! })));
    expect(await Bun.file(join(out, 'bundle.json')).json()).toEqual(bundle);
    const actual = await Bun.file(join(out, 'wrangler.jsonc')).json();
    const types = { esm: 'ESModule', text: 'Text', data: 'Data' };
    expect(actual).toEqual({ ...config, assets: { ...config.assets, directory: './web' }, rules:
      (Object.keys(types) as WorkerModule['type'][]).map(type => ({ type: types[type],
        globs: bundle.modules.filter(module => module.type === type).map(module => module.name), fallthrough: false })) });
    expect(actual.rules.flatMap((rule: { globs: string[] }) => rule.globs)).toEqual(expect.arrayContaining(modules.map(item => item.name)));
    expect(actual.rules.flatMap((rule: { globs: string[] }) => rule.globs)).not.toContain('README.md');
    expect(await Bun.file(join(out, 'web/index.html')).text()).toBe(await Bun.file('dist/web/index.html').text());
    expect(bundle.identity.webDigest).toBeString();
    expect(await Bun.file(join(out, 'migrations/0007.sql')).exists()).toBe(true);

    // A source checkout's root configuration can deploy into its generated dist directory.
    const deployment = await prepareWorkerDeployment({ config: configPath, out: join(previous, 'dist/worker'),
      accountId: 'fixture-account', apiToken: 'fixture-token', fetcher });
    expect(deployment.mode).toBe('upgrade');
    expect(await Bun.file(join(previous, 'dist/worker/registry.mjs')).text()).toBe(registry);
    expect(deployment.bundle.identity.plugins).toEqual(bundle.identity.plugins);
    const deployConfig = await Bun.file(deployment.config).json();
    expect(deployConfig.d1_databases[0].database_id).toBe('retained-d1');
    expect(deployConfig.vars.CF_WORKER_NAME).toBe('musicfs-fixture');
    expect(await Bun.file(configPath).text()).toBe(configText);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
