import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { ReleaseIdentity } from '../scripts/helpers/release-identity';

const packageScript = resolve(import.meta.dir, '../scripts/package-release.ts');
const identityScript = resolve(import.meta.dir, '../scripts/helpers/release-identity.ts');
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

async function command(directory: string, args: string[]): Promise<string> {
  const child = Bun.spawn(args, { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${args[0]} exited ${code}: ${stderr}`);
  return stdout;
}

test('packages each version together and replaces only that version on a repeat build', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-package-release-'));
  const releaseVersion = '0.0.0-test.1';
  const write = async (path: string, value: string | Uint8Array) => {
    const target = join(directory, path); await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, value);
  };
  const json = (path: string, value: unknown) => write(path, JSON.stringify(value));
  try {
    await json('package.json', { version: releaseVersion, packageManager: `bun@${Bun.version}`, type: 'module' });
    await write('src/fixture.ts', 'export const fixture = true;\n');
    await write('.github/workflows/release.yml', 'name: Release fixture\n');
    await command(directory, ['git', 'init', '--quiet']);
    await command(directory, ['git', 'add', 'package.json', 'src/fixture.ts']);
    await command(directory, ['git', '-c', 'user.name=MusicFS fixture', '-c', 'user.email=fixture@musicfs.invalid', 'commit', '--quiet', '-m', 'Fixture']);
    const source = JSON.parse(await command(directory, [Bun.which('bun')!, '--eval',
      `import { currentSourceIdentity } from ${JSON.stringify(identityScript)}; console.log(JSON.stringify(await currentSourceIdentity()));`
    ])) as Pick<ReleaseIdentity, 'version' | 'apiVersion' | 'source'>;
    const plugins = await Promise.all([
      { id: 'org.musicfs.sample', path: 'dist/plugins/org.musicfs.sample.zip' },
      { id: 'org.musicfs.qq', path: 'dist/plugins/org.musicfs.qq.zip' },
      { id: 'org.musicfs.netease', path: 'dist/netease/org.musicfs.netease.zip' }
    ].map(async plugin => {
      const manifest = { id: plugin.id, version: '0.0.0-test.1' };
      const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)) });
      await write(plugin.path, bytes);
      for (const parent of ['dist/desktop/linux-x64/plugins', 'dist/worker/plugin-packages']) {
        await mkdir(join(directory, parent), { recursive: true });
        await cp(join(directory, plugin.path), join(directory, parent, `${plugin.id}.zip`));
      }
      return { ...manifest, revision: hash(bytes) };
    }));
    const identity: ReleaseIdentity = { ...source, webDigest: 'a'.repeat(64), plugins };
    const executable = strToU8('fixture executable'); await write('dist/desktop/linux-x64/musicfs', executable);
    await json('dist/desktop/linux-x64/release.json', {
      target: 'linux-x64', entrypoint: 'src/desktop.ts', executable: 'musicfs', executableSha256: hash(executable), identity
    });
    await json('dist/worker/bundle.json', {
      entrypoint: 'src/worker.ts', identity,
      plugins: plugins.map(({ id, version, revision }) => ({ manifest: { id, version }, revision }))
    });
    await json('dist/plugin-author-kit/release.json', { kind: 'plugin-author-kit', identity: { ...identity, webDigest: null, plugins: [] } });
    await write('dist/releases/0.0.0-previous/SHA256SUMS', 'previous release\n');
    await write('dist/releases/SHA256SUMS', 'legacy flat release\n');
    const output = join(directory, 'dist/releases', releaseVersion);
    const run = (...options: string[]) => command(directory, [Bun.which('bun')!, packageScript, '--targets', 'linux-x64', ...options]);
    expect(JSON.parse(await run()).directory).toBe(output);
    expect((await readdir(output)).sort()).toEqual([
      'SHA256SUMS', `musicfs-${releaseVersion}-linux-x64.zip`, `musicfs-${releaseVersion}-plugin-author-kit.zip`,
      `musicfs-${releaseVersion}-source.zip`, `musicfs-${releaseVersion}-worker.zip`, 'plugins', 'release-manifest.json'
    ].sort());
    const manifest = await Bun.file(join(output, 'release-manifest.json')).json();
    expect(manifest.identity).toEqual(identity);
    const sourceArchive = unzipSync(new Uint8Array(await Bun.file(join(output, `musicfs-${releaseVersion}-source.zip`)).arrayBuffer()));
    expect(strFromU8(sourceArchive[`musicfs-${releaseVersion}-source/.github/workflows/release.yml`]!)).toBe('name: Release fixture\n');
    for (const line of (await Bun.file(join(output, 'SHA256SUMS')).text()).trim().split('\n')) {
      const [checksum, file] = line.split('  ') as [string, string];
      expect(hash(new Uint8Array(await Bun.file(join(output, file)).arrayBuffer()))).toBe(checksum);
    }
    await write(`dist/releases/${releaseVersion}/obsolete.zip`, 'old output');
    await run();
    expect(await Bun.file(join(output, 'obsolete.zip')).exists()).toBe(false);
    expect(await Bun.file(join(directory, 'dist/releases/0.0.0-previous/SHA256SUMS')).text()).toBe('previous release\n');
    expect(await Bun.file(join(directory, 'dist/releases/SHA256SUMS')).text()).toBe('legacy flat release\n');
    expect((await readdir(join(directory, 'dist/releases'))).some(name => name.startsWith('.packaging-'))).toBe(false);

    // GitHub Release attachments share one directory; their manifest and checksums must use the same paths.
    await run('--flat-plugins');
    const flatManifest = await Bun.file(join(output, 'release-manifest.json')).json();
    expect(await Bun.file(join(output, 'plugins')).exists()).toBe(false);
    expect(flatManifest.plugins.map((plugin: { file: string }) => plugin.file).sort()).toEqual(
      plugins.map(plugin => `${plugin.id}-${plugin.version}.zip`).sort());
    for (const line of (await Bun.file(join(output, 'SHA256SUMS')).text()).trim().split('\n')) {
      const [checksum, file] = line.split('  ') as [string, string];
      expect(file).not.toContain('/');
      expect(hash(new Uint8Array(await Bun.file(join(output, file)).arrayBuffer()))).toBe(checksum);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
