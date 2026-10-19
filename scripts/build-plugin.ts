import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js/index-native.js';
import type { PluginManifest } from '@musicfs/plugin-api';

/** Author tooling: bundle a plugin closure and package only its explicitly declared files. */
export async function buildPlugin(directory: string, destination: string, options: { define?: Record<string, string> } = {}): Promise<Uint8Array> {
  const manifest = await Bun.file(join(directory, 'manifest.json')).json() as PluginManifest;
  const build = await Bun.build({ entrypoints: [join(directory, 'index.ts')], target: 'browser', format: 'esm', minify: false, ...options });
  if (!build.success || !build.outputs[0]) throw new AggregateError(build.logs, `Plugin build failed: ${manifest.id}`);
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: false });
  for (const name of ['manifest.json', ...manifest.files]) {
    const bytes = name === 'index.mjs' ? new Uint8Array(await build.outputs[0].arrayBuffer()) : new Uint8Array(await Bun.file(join(directory, name)).arrayBuffer());
    await writer.add(name, new Uint8ArrayReader(bytes), { lastModDate: new Date('2026-01-01T00:00:00Z') });
  }
  const archive = await writer.close(); await mkdir(dirname(destination), { recursive: true }); await Bun.write(destination, archive);
  await Bun.write(join(dirname(destination), manifest.id, 'index.mjs'), build.outputs[0]);
  return archive;
}
