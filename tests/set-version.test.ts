import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setVersion } from '../scripts/set-version';

const script = resolve(import.meta.dir, '../scripts/set-version.ts');
const releaseGuides = ['docs/release.md', 'docs/en/release.md'];

test('the version command updates both release guides and package names while preserving other versions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-set-version-'));
  const metadata = { name: 'musicfs', version: '0.1.0-dev.31', scripts: { test: 'bun test' } };
  const history = 'Previous release: 0.1.0-dev.31\n';
  try {
    for (const file of [...releaseGuides, 'docs/release-history.md', 'plugins/sample/manifest.json']) {
      await mkdir(dirname(join(directory, file)), { recursive: true });
    }
    await writeFile(join(directory, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
    await writeFile(join(directory, 'docs/release-history.md'), history);
    await writeFile(join(directory, 'plugins/sample/manifest.json'), '{"version":"0.1.4"}\n');
    for (const file of releaseGuides) {
      const source = await readFile(resolve(import.meta.dir, '..', file), 'utf8');
      await writeFile(join(directory, file), source + '\nUnrelated version: 0.1.0-dev.31\n');
    }
    const child = Bun.spawn([process.execPath, script, '0.1.0-dev.32'], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toContain('0.1.0-dev.31 → 0.1.0-dev.32');
    expect(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))).toEqual({ ...metadata, version: '0.1.0-dev.32' });
    for (const file of releaseGuides) {
      const text = await readFile(join(directory, file), 'utf8');
      expect(text).toContain('**0.1.0-dev.32**');
      const packages = [...text.matchAll(/`(musicfs-[^`]+\.zip)`/g)].map(match => match[1]!);
      expect(packages).toHaveLength(5);
      for (const name of packages) expect(name).toStartWith('musicfs-0.1.0-dev.32-');
      expect(text).toContain('https://github.com/shengyusi-SYS/musicfs/releases');
      expect(text).not.toMatch(/\]\((?:\.\.\/)+dist\//);
      expect(text).toContain('Unrelated version: 0.1.0-dev.31');
    }
    expect((await setVersion('0.1.0-dev.32', directory)).changed).toEqual([]);

    await setVersion('0.1.0', directory);
    expect(await readFile(join(directory, releaseGuides[0]!), 'utf8')).toContain('当前版本为 **0.1.0**。');
    expect(await readFile(join(directory, releaseGuides[1]!), 'utf8')).toContain('Current version: **0.1.0**.');
    expect(await readFile(join(directory, 'docs/release-history.md'), 'utf8')).toBe(history);
    expect(await readFile(join(directory, 'plugins/sample/manifest.json'), 'utf8')).toBe('{"version":"0.1.4"}\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an invalid version or missing guide marker does not partially change the release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-set-version-'));
  const metadata = '{"version":"0.1.0-dev.31"}\n';
  try {
    await mkdir(join(directory, 'docs/en'), { recursive: true });
    await writeFile(join(directory, 'package.json'), metadata);
    await writeFile(join(directory, 'docs/release.md'), '<!-- release-version -->\nCurrent\n');
    await writeFile(join(directory, 'docs/en/release.md'), 'Missing marker\n');
    await expect(setVersion('v0.1.0', directory)).rejects.toThrow('semantic version');
    await expect(setVersion('0.1.0', directory)).rejects.toThrow('docs/en/release.md');
    expect(await readFile(join(directory, 'package.json'), 'utf8')).toBe(metadata);
    expect(await readFile(join(directory, 'docs/release.md'), 'utf8')).toBe('<!-- release-version -->\nCurrent\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
