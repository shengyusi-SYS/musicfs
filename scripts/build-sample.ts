import { mkdir } from 'node:fs/promises';
import Ajv from 'ajv';
import standalone from 'ajv/dist/standalone/index.js';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js/index-native.js';
import schema from '../plugins/sample/config.schema.json';
import manifest from '../plugins/sample/manifest.json';

export async function buildSample(): Promise<Uint8Array> {
  const ajv = new Ajv({ allErrors: true, code: { source: true, esm: true } });
  await Bun.write('plugins/sample/generated-config.mjs', standalone(ajv, ajv.compile(schema)));
  const build = await Bun.build({ entrypoints: ['plugins/sample/index.ts'], target: 'browser', format: 'esm', minify: false });
  if (!build.success || !build.outputs[0]) throw new AggregateError(build.logs, 'Sample plugin build failed');
  const module = new Uint8Array(await build.outputs[0].arrayBuffer());
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: false });
  const files = new Map<string, Uint8Array>([
    ['manifest.json', new TextEncoder().encode(JSON.stringify(manifest))],
    ['index.mjs', module],
    ['config.schema.json', new TextEncoder().encode(JSON.stringify(schema))],
    ['LICENSE.txt', new Uint8Array(await Bun.file('plugins/sample/LICENSE.txt').arrayBuffer())]
  ]);
  const date = new Date('2026-01-01T00:00:00Z');
  for (const [name, bytes] of files) await writer.add(name, new Uint8ArrayReader(bytes), { lastModDate: date });
  const archive = await writer.close();
  await mkdir('dist/plugins', { recursive: true });
  await Bun.write('dist/plugins/org.musicfs.sample.zip', archive);
  return archive;
}

if (import.meta.main) {
  const archive = await buildSample();
  console.log(`Built dist/plugins/org.musicfs.sample.zip (${archive.byteLength} bytes)`);
}
