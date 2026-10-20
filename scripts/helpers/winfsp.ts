import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const version = '2.1.25156';
const filename = `winfsp-${version}.msi`;
const url = `https://github.com/winfsp/winfsp/releases/download/v2.1/${filename}`;
const sha256 = '073a70e00f77423e34bed98b86e600def93393ba5822204fac57a29324db9f7a';

/** Copy only the pinned official runtime installer; no source or developer tools. */
export async function copyWinFspPrerequisite(resourcesDirectory: string): Promise<void> {
  const cacheDirectory = resolve('dist/tools', `winfsp-${version}`);
  const cached = join(cacheDirectory, filename);
  let bytes: Uint8Array | undefined;
  if (await Bun.file(cached).exists()) bytes = new Uint8Array(await readFile(cached));
  if (!bytes || new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== sha256) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Official WinFsp artifact fetch failed (${response.status})`);
    bytes = new Uint8Array(await response.arrayBuffer());
    if (new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Official WinFsp installer checksum mismatch');
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(cached, bytes);
  }
  const metadata = { version, filename, url, sha256, features: ['F.User', 'F.Main'] };
  await writeFile(join(cacheDirectory, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
  const target = join(resourcesDirectory, 'prerequisites');
  await mkdir(target, { recursive: true });
  await cp(cached, join(target, filename));
  await writeFile(join(target, 'winfsp-release.json'), JSON.stringify(metadata, null, 2) + '\n');
}
