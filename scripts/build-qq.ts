import { dirname, join, resolve } from 'node:path';
import Ajv from 'ajv';
import standalone from 'ajv/dist/standalone/index.js';
import schema from '../plugins/qq/config.schema.json';
import { buildPlugin } from './build-plugin';

export async function buildQq() {
  const ajv = new Ajv({ allErrors: true, code: { source: true, esm: true } });
  await Bun.write('plugins/qq/generated-config.mjs', standalone(ajv, ajv.compile(schema)));
  const dependency = dirname(Bun.resolveSync('@yakult-green-tea/qq-music-api/package.json', resolve('plugins/qq')));
  const metadata = await Bun.file(join(dependency, 'package.json')).json() as { version: string };
  if (metadata.version !== '3.3.3') throw new Error('Revalidate the QQ private SDK adapter before upgrading its pinned dependency');
  const exports = [
    ['createSealedSessionResolver', 'serverless/sealedResolver.js'],
    ['deriveAndroidDevice', 'serverless/derivedDevice.js'],
    ['createSessionMusicuClient', 'services/recommend/sessionMusicu.js'],
    ['AUTH_REFRESH_EARLY_MS, AUTH_REFRESH_RETRY_MS', 'services/auth/sessionState.js'],
    ['createFetchTransport', 'transport/fetch.js'],
    ['refreshLoginCredential', 'services/auth/authenticatedReads.js'],
    ['credentialMusicId', 'services/auth/androidDevice.js'],
    ['QqApiError', 'protocol/errors.js'],
    ['StreamCdnSelector', 'services/auth/streamCdnSelector.js'],
    ['DAILY_SONGS', 'services/recommend/dailySongs.js'],
    ['recommendPlaylistsResult', 'services/recommend/recommendPlaylists.js'],
    ['apeFileFailureOf', 'protocol/qualityFile.js'],
    ['MUSIC_FILE_TYPES', 'services/auth/playback.js']
  ] as const;
  const upstream = [];
  for (const [name, file] of exports) {
    if (!await Bun.file(join(dependency, 'dist-esm/src', file)).exists()) throw new Error(`Pinned QQ SDK export disappeared: ${file}`);
    upstream.push(`export { ${name} } from ${JSON.stringify('./node_modules/@yakult-green-tea/qq-music-api/dist-esm/src/' + file)};`);
  }
  await Bun.write('plugins/qq/generated-upstream.mjs', upstream.join('\n') + '\n');
  await Bun.write('plugins/qq/LICENSE.txt', await Bun.file('plugins/sample/LICENSE.txt').text());
  const licenses = [];
  for (const [name, location] of [['@yakult-green-tea/qq-music-api 3.3.3', join(dependency, 'LICENSE')], ['Zod 4.6.7', 'node_modules/zod/LICENSE'], ['Ajv 8.20.0', 'node_modules/ajv/LICENSE']]) {
    licenses.push(`${name}\n\n${await Bun.file(location!).text()}`);
  }
  await Bun.write('plugins/qq/THIRD_PARTY_LICENSE.txt', licenses.join('\n\n---\n\n'));
  await Bun.write('plugins/qq/THIRD_PARTY_ATTRIBUTION.md', await Bun.file(join(dependency, 'ATTRIBUTION.md')).text());
  // The SDK logger reads process.env. Freeze its logging settings at author build time;
  // the installed bundle has no process global or host environment dependency.
  return buildPlugin('plugins/qq', 'dist/plugins/org.musicfs.qq.zip', { define: { 'process.env': JSON.stringify({ LOG_LEVEL: 'error' }) } });
}
if (import.meta.main) console.log(`Built QQ development plugin (${(await buildQq()).byteLength} bytes)`);
