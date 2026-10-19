import { mkdir } from 'node:fs/promises';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js/index-native.js';
import { buildSample } from './build-sample';
import { fixtureManifest } from '../tests/fixtures/authentication-plugin';

// Development test artifact, not one of the product's example music sources.
await buildSample();
const result = await Bun.build({ entrypoints: ['tests/fixtures/authentication-plugin.ts'], target: 'browser', format: 'esm' });
if (!result.success || !result.outputs[0]) throw new AggregateError(result.logs, 'Authentication fixture build failed');
const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: false });
for (const [name, bytes] of new Map([
  ['manifest.json', new TextEncoder().encode(JSON.stringify(fixtureManifest))], ['index.mjs', new Uint8Array(await result.outputs[0].arrayBuffer())],
  ['LICENSE.txt', new Uint8Array(await Bun.file('plugins/sample/LICENSE.txt').arrayBuffer())]
])) await writer.add(name, new Uint8ArrayReader(bytes));
await mkdir('dist/p0', { recursive: true }); await Bun.write('dist/p0/authentication-fixture.zip', await writer.close());
console.log('Built development-only authentication fixture: dist/p0/authentication-fixture.zip');
