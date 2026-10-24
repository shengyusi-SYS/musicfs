import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { flattenDiagnosticMessageText, parseConfigFileTextToJson } from 'typescript';
import { isPackagePath, parsePackageManifest } from '../src/core/extensions';
import { createWorkerPublisher, type WorkerModule } from '../src/hosts/worker/publisher';
import { buildWorker, type WorkerBundle } from './build-worker';

export type UpgradeConfig = Record<string, unknown> & {
  name?: string; account_id?: string; vars?: Record<string, unknown>;
  assets?: Record<string, unknown>;
};

const within = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
};

/** Prepare one Wrangler input; deployment and D1 migrations remain explicit operator steps. */
export async function buildWorkerUpgrade(input: {
  config: string; out: string; accountId?: string; apiToken?: string; fetcher?: typeof fetch;
}): Promise<WorkerBundle> {
  const configPath = resolve(input.config); const directory = resolve(input.out);
  if (within(directory, dirname(configPath))) {
    throw new Error('Use an upgrade output directory separate from the existing configuration directory');
  }
  const parsed = parseConfigFileTextToJson(configPath, await Bun.file(configPath).text());
  if (parsed.error) throw new Error(flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  const config = parsed.config as UpgradeConfig;
  const accountId = input.accountId ?? config.account_id ?? config.vars?.CF_ACCOUNT_ID;
  const apiToken = input.apiToken ?? process.env.CF_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  if (typeof accountId !== 'string' || !config.name || !config.assets) {
    throw new Error('The existing Worker config must specify account_id (or CF_ACCOUNT_ID), name and assets');
  }
  if (!apiToken) throw new Error('Set CF_API_TOKEN or CLOUDFLARE_API_TOKEN before preparing the upgrade');
  if (!await Bun.file('dist/web/index.html').exists()) throw new Error('Run bun run build:web before preparing the upgrade');

  const publisher = createWorkerPublisher({ accountId, scriptName: config.name, apiToken,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}) });
  const current = await publisher.content(AbortSignal.timeout(20_000));
  if (current.mainModule !== 'worker.mjs') throw new Error('Expected the MusicFS worker.mjs entrypoint');
  const retained = current.modules.filter(module => module.name !== 'worker.mjs' && module.name !== 'core.mjs');
  const plugins: WorkerBundle['plugins'] = [];
  for (const module of retained) {
    if (!isPackagePath(module.name)) throw new Error(`Unsupported Worker module path: ${module.name}`);
    const manifest = /^plugins\/([a-f0-9]{64})\/manifest\.json$/.exec(module.name);
    if (manifest) plugins.push({ manifest: parsePackageManifest(JSON.parse(new TextDecoder().decode(module.bytes))), revision: manifest[1]! });
  }

  const bundle = await buildWorker({ directory });
  bundle.modules = bundle.modules.filter(module => module.name === 'worker.mjs' || module.name === 'core.mjs');
  for (const module of retained) {
    const destination = join(directory, module.name);
    await mkdir(dirname(destination), { recursive: true });
    await Bun.write(destination, module.bytes);
    bundle.modules.push({ name: module.name, file: module.name, type: module.type });
  }
  bundle.plugins = plugins;
  bundle.identity.plugins = plugins.map(({ manifest, revision }) => ({ id: manifest.id, version: manifest.version, revision }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en') || a.revision.localeCompare(b.revision, 'en'));
  await Bun.write(join(directory, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n');

  const types: Record<WorkerModule['type'], string> = { esm: 'ESModule', text: 'Text', data: 'Data' };
  const rules = (Object.keys(types) as WorkerModule['type'][]).flatMap(type => {
    const globs = bundle.modules.filter(module => module.type === type).map(module => module.name);
    return globs.length ? [{ type: types[type], globs, fallthrough: false }] : [];
  });
  await Bun.write(join(directory, 'wrangler.jsonc'), JSON.stringify({ ...config,
    main: bundle.mainModule, no_bundle: true, find_additional_modules: true,
    assets: { ...config.assets, directory: './web' }, rules
  }, null, 2) + '\n');
  return bundle;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { config: { type: 'string' }, out: { type: 'string' } } });
  if (!values.config || !values.out) throw new Error('Usage: bun scripts/build-worker-upgrade.ts --config EXISTING_CONFIG --out NEW_DIRECTORY');
  const bundle = await buildWorkerUpgrade({ config: values.config, out: values.out });
  console.log(JSON.stringify({ directory: resolve(values.out), modules: bundle.modules.length,
    plugins: bundle.identity.plugins, deployed: false }));
}
