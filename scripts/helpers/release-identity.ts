import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PLUGIN_API_VERSION } from '../../src/core/extensions';

export type ReleaseIdentity = {
  version: string; apiVersion: string;
  source: { revision: string; digest: string; dirty: boolean };
  webDigest: string | null;
  plugins: { id: string; version: string; revision: string }[];
};

const inputs = ['src', 'native/desktop', 'packages/plugin-api', 'packages/audio-tags/src', 'packages/audio-tags/package.json', 'plugins', 'scripts/build*.ts', 'scripts/package-release.ts', 'scripts/helpers',
  'package.json', 'bun.lock', 'tsconfig*.json', 'vite.config.ts', 'worker-template', 'third-party', 'LICENSE',
  'docs/desktop.md', 'docs/worker.md', 'docs/clients.md', 'docs/user-guide.md', 'docs/plugin-authoring.md', 'docs/architecture/plugin-interface.md'];
function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error('Release identity requires the source Git checkout');
  return new TextDecoder().decode(result.stdout);
}

/** Hash build inputs, including unstaged additions, without reading generated or private data. */
export async function currentSourceIdentity(): Promise<Pick<ReleaseIdentity, 'version' | 'apiVersion' | 'source'>> {
  const metadata = await Bun.file('package.json').json() as { version: string; packageManager: string };
  if (metadata.packageManager !== `bun@${Bun.version}`) throw new Error(`Use ${metadata.packageManager} to build a release`);
  const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...inputs]).split('\0').filter(Boolean))].sort();
  const hash = new Bun.CryptoHasher('sha256');
  for (const name of files) {
    const file = Bun.file(name);
    if (!await file.exists()) continue; // A removed tracked input must not retain its old content hash.
    hash.update(name + '\0' + file.size + '\0').update(await file.arrayBuffer());
  }
  return { version: metadata.version, apiVersion: PLUGIN_API_VERSION, source: {
    revision: git(['rev-parse', 'HEAD']).trim(), digest: hash.digest('hex'),
    dirty: git(['status', '--porcelain', '--untracked-files=all', '--', ...inputs]).length > 0
  } };
}

export async function directoryDigest(directory: string): Promise<string> {
  const root = resolve(directory); const hash = new Bun.CryptoHasher('sha256');
  async function visit(relative: string) {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const file = Bun.file(join(root, path));
        hash.update(path + '\0' + file.size + '\0').update(await file.arrayBuffer());
      } else throw new Error(`Unexpected non-file build output: ${path}`);
    }
  }
  await visit(''); return hash.digest('hex');
}

export async function createReleaseIdentity(plugins: readonly { manifest: { id: string; version: string }; digest: string }[] = [], webDirectory?: string): Promise<ReleaseIdentity> {
  return { ...await currentSourceIdentity(), webDigest: webDirectory ? await directoryDigest(webDirectory) : null,
    plugins: plugins.map(item => ({ id: item.manifest.id, version: item.manifest.version, revision: item.digest })).sort((a, b) => a.id.localeCompare(b.id, 'en')) };
}
