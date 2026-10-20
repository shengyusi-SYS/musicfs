import Ajv from 'ajv';
import standalone from 'ajv/dist/standalone/index.js';
import schema from '../plugins/sample/config.schema.json';
import manifest from '../plugins/sample/manifest.json';
import { buildPlugin } from './build-plugin';

export async function buildSample(): Promise<Uint8Array> {
  const ajv = new Ajv({ allErrors: true, code: { source: true, esm: true } });
  await Bun.write('plugins/sample/generated-config.mjs', standalone(ajv, ajv.compile(schema)));
  const metadata = await Bun.file('node_modules/ajv/package.json').json() as { version: string };
  await Bun.write('plugins/sample/THIRD_PARTY_LICENSE.txt', `Ajv ${metadata.version}\n\n${await Bun.file('node_modules/ajv/LICENSE').text()}`);
  return buildPlugin('plugins/sample', `dist/plugins/${manifest.id}.zip`);
}

if (import.meta.main) {
  const archive = await buildSample();
  console.log(`Built dist/plugins/${manifest.id}.zip (${archive.byteLength} bytes)`);
}
