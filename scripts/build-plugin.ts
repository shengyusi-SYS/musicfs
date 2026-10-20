import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js/index-native.js';
import type { PluginManifest } from '@musicfs/plugin-api';
import type { BunPlugin } from 'bun';

/** Author tooling: bundle a plugin closure and package only its explicitly declared files. */
export async function buildPlugin(directory: string, destination: string, options: { define?: Record<string, string>; external?: string[]; plugins?: BunPlugin[]; banner?: string } = {}): Promise<Uint8Array> {
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

/** Author-side wrapper for bundled CJS format libraries on nodejs_compat Workers. */
export const audioTagBuildOptions = {
  external: ['node:*', 'fs', 'path', 'os', 'buffer', 'stream', 'util', 'assert', 'child_process', 'events', 'string_decoder'],
  banner: 'import {createRequire as musicfsCreateRequire} from "node:module"; const require = musicfsCreateRequire("file:///musicfs-plugin.mjs");'
};

/** Read only the notices for this optional dependency's installed runtime packages. */
export async function audioTagLicenses(): Promise<string[]> {
  const roots = new Map<string, string>([['author', resolve('packages/audio-tags')]]);
  const notices: string[] = [];
  for (const [name, parent] of [
    ['node-taglib-sharp', 'author'], ['iconv-lite', 'node-taglib-sharp'], ['safer-buffer', 'iconv-lite'],
    ['os-locale', 'node-taglib-sharp'], ['lcid', 'os-locale'], ['invert-kv', 'lcid'], ['uuid', 'node-taglib-sharp']
  ]) {
    const root = dirname(Bun.resolveSync(`${name}/package.json`, roots.get(parent!)!)); roots.set(name!, root);
    const info = await Bun.file(join(root, 'package.json')).json() as { name: string; version: string };
    const license = (await Promise.all(['LICENSE', 'LICENSE.md', 'license', 'license.md'].map(async file =>
      await Bun.file(join(root, file)).exists() ? join(root, file) : null))).find(file => file !== null);
    if (!license) throw new Error(`Missing runtime notice: ${name}`);
    notices.push(`${info.name} ${info.version}\n\n${await Bun.file(license).text()}`);
  }
  return notices;
}
