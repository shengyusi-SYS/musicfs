import { dirname, join, resolve } from 'node:path';
import Ajv from 'ajv';
import standalone from 'ajv/dist/standalone/index.js';
import schema from '../plugins/netease/config.schema.json';
import { audioTagBuildOptions, audioTagLicenses, buildPlugin } from './build-plugin';

/** Pin and bundle original upstream source; no generated source edits or protocol replacements. */
export async function buildNetease() {
  const directory = 'plugins/netease';
  const ajv = new Ajv({ allErrors: true, code: { source: true, esm: true } });
  await Bun.write(join(directory, 'generated-config.mjs'), standalone(ajv, ajv.compile(schema)));
  const dependency = dirname(Bun.resolveSync('NeteaseCloudMusicApi/package.json', resolve(directory)));
  const metadata = await Bun.file(join(dependency, 'package.json')).json() as { version: string };
  if (metadata.version !== '4.32.0') throw new Error('Revalidate the pinned NetEase private SDK adapter before upgrading');
  const modules = { qrKey: 'login_qr_key', qrCheck: 'login_qr_check', status: 'login_status', refresh: 'login_refresh', userPlaylists: 'user_playlist',
    playlist: 'playlist_detail', songs: 'song_detail', daily: 'recommend_songs', recommended: 'recommend_resource', playback: 'song_url_v1', lyric: 'lyric_new', album: 'album' };
  const imports = [];
  for (const [name, file] of Object.entries(modules)) {
    const path = join(dependency, 'module', file + '.js');
    if (!await Bun.file(path).exists()) throw new Error(`Pinned NetEase SDK module disappeared: ${file}`);
    imports.push(`import ${name} from ${JSON.stringify(path)};`);
  }
  imports.push(`import encrypt from ${JSON.stringify(join(dependency, 'util/crypto.js'))};`, `export { encrypt };`, `export const endpoints = { ${Object.keys(modules).join(', ')} };`);
  await Bun.write(join(directory, 'generated-upstream.mjs'), imports.join('\n') + '\n');
  await Bun.write(join(directory, 'LICENSE.txt'), await Bun.file('plugins/sample/LICENSE.txt').text());
  const dependencies: [string, string][] = [];
  let lookup = resolve(directory);
  for (const name of ['NeteaseCloudMusicApi', 'crypto-js', 'node-forge']) {
    const root = dirname(Bun.resolveSync(`${name}/package.json`, dependency));
    const info = await Bun.file(join(root, 'package.json')).json() as { version: string };
    dependencies.push([`${name} ${info.version}`, join(root, 'LICENSE')]);
  }
  for (const name of ['tough-cookie', 'tldts', 'tldts-core']) {
    const root = dirname(Bun.resolveSync(`${name}/package.json`, lookup));
    const info = await Bun.file(join(root, 'package.json')).json() as { version: string };
    dependencies.push([`${name} ${info.version}`, join(root, 'LICENSE')]); lookup = root;
  }
  lookup = resolve(directory);
  for (const name of ['p-limit', 'yocto-queue']) {
    const root = dirname(Bun.resolveSync(name, lookup));
    const info = await Bun.file(join(root, 'package.json')).json() as { version: string };
    dependencies.push([`${name} ${info.version}`, join(root, 'license')]); lookup = root;
  }
  dependencies.push(['Zod 4.6.7', 'node_modules/zod/LICENSE'], ['Ajv 8.20.0', 'node_modules/ajv/LICENSE']);
  const licenses = [];
  for (const [name, path] of dependencies) licenses.push(`${name}\n\n${await Bun.file(path!).text()}`);
  licenses.push(...await audioTagLicenses());
  await Bun.write(join(directory, 'THIRD_PARTY_LICENSE.txt'), licenses.join('\n\n---\n\n'));
  return buildPlugin(directory, 'dist/netease/org.musicfs.netease.zip', {
    ...audioTagBuildOptions,
    external: [...audioTagBuildOptions.external, 'node:crypto', 'node:zlib'],
    plugins: [{ name: 'netease-node-builtins', setup(builder) {
      // CJS external require is not available in a Worker ES module. A static
      // namespace bridge preserves the original upstream import unchanged.
      builder.onResolve({ filter: /^(crypto|zlib)$/ }, args => ({ path: args.path, namespace: 'netease-native' }));
      builder.onResolve({ filter: /^node:(crypto|zlib)$/ }, args => ({ path: args.path, external: true }));
      builder.onLoad({ filter: /./, namespace: 'netease-native' }, args => ({ loader: 'js',
        contents: `import * as native from ${JSON.stringify(`node:${args.path}`)}; module.exports = native;` }));
    } }]
  });
}
if (import.meta.main) console.log(`Built NetEase development plugin (${(await buildNetease()).byteLength} bytes)`);
