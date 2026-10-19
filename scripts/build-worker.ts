import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { PluginManifest } from '@musicfs/plugin-api';
import { readPackage } from '../src/infrastructure/archives';

export type WorkerBundle = {
  formatVersion: 1; mainModule: string;
  modules: { name: string; type: 'esm' | 'text' | 'data'; file: string }[];
  plugins: { manifest: PluginManifest; revision: string }[];
};

/** Author/release tooling. Core and prebuilt plugin modules remain independently replaceable. */
export async function buildWorker(input: { directory?: string; pluginArchives?: string[]; entrypoint?: string } = {}): Promise<WorkerBundle> {
  const directory = resolve(input.directory ?? 'dist/worker');
  const prepared = await Promise.all((input.pluginArchives ?? []).map(async path =>
    readPackage(new Uint8Array(await Bun.file(path).arrayBuffer()), 'worker', new AbortController().signal)));
  if (new Set(prepared.map(item => item.manifest.id)).size !== prepared.length) throw new Error('Choose one initial revision per plugin');
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const build = await Bun.build({ entrypoints: [input.entrypoint ?? 'src/worker.ts'], target: 'browser', format: 'esm',
    outdir: directory, naming: 'core.mjs' });
  if (!build.success) throw new AggregateError(build.logs, 'Worker core build failed');
  const bundle: WorkerBundle = { formatVersion: 1, mainModule: 'worker.mjs',
    modules: [{ name: 'worker.mjs', type: 'esm', file: 'worker.mjs' }, { name: 'core.mjs', type: 'esm', file: 'core.mjs' },
      { name: 'registry.mjs', type: 'esm', file: 'registry.mjs' }],
    plugins: prepared.map(item => ({ manifest: item.manifest, revision: item.digest })) };
  const imports: string[] = ["import {assertPluginModule} from './core.mjs';"]; const validations: string[] = []; const registrations: string[] = [];
  for (const [index, item] of prepared.entries()) {
    const prefix = `plugins/${item.digest}/`;
    imports.push(`import plugin${index} from ${JSON.stringify('./' + prefix + item.manifest.hosts.worker)};`);
    validations.push(`assertPluginModule(plugin${index});`);
    registrations.push(`{id:${JSON.stringify(item.manifest.id)},revision:${JSON.stringify(item.digest)},module:plugin${index}}`);
    for (const [name, bytes] of item.files) {
      const moduleName = prefix + name; const destination = join(directory, moduleName);
      await mkdir(dirname(destination), { recursive: true });
      await Bun.write(destination, bytes);
      bundle.modules.push({ name: moduleName, file: moduleName,
        type: /\.(?:m?js)$/.test(name) ? 'esm' : /\.(?:json|txt|md)$/.test(name) ? 'text' : 'data' });
    }
  }
  await Bun.write(join(directory, 'worker.mjs'), "import createWorker from './core.mjs';\nimport {registrations} from './registry.mjs';\nexport default createWorker(registrations);\n");
  await Bun.write(join(directory, 'registry.mjs'), [...imports, ...validations].join('\n') + `\nexport const registrations=[${registrations.join(',')}];\n`);
  await Bun.write(join(directory, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
  await cp('worker-template/wrangler.jsonc', join(directory, 'wrangler.jsonc'));
  await cp('src/infrastructure/persistence/migrations', join(directory, 'migrations'), { recursive: true });
  if (await Bun.file('dist/web/index.html').exists()) await cp('dist/web', join(directory, 'web'), { recursive: true });
  return bundle;
}

if (import.meta.main) {
  const archives = Bun.argv.slice(2);
  const bundle = await buildWorker({ pluginArchives: archives });
  console.log(JSON.stringify({ directory: resolve('dist/worker'), modules: bundle.modules.length,
    plugins: bundle.plugins.map(item => item.manifest.id), hasWebUI: (await readdir('dist/worker')).includes('web') }));
}
