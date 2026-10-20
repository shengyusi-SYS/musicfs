import { createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { BlobReader, TextWriter, ZipReader, ZipWriter } from '@zip.js/zip.js/index-native.js';
import { valid } from 'semver';
import { z } from 'zod';
import { currentSourceIdentity, type ReleaseIdentity } from './helpers/release-identity';

const targets = ['linux-x64', 'windows-x64', 'macos-x64', 'macos-arm64'] as const;
type Target = typeof targets[number];
const pluginInputs = [
  { id: 'org.musicfs.sample', path: 'dist/plugins/org.musicfs.sample.zip' },
  { id: 'org.musicfs.qq', path: 'dist/plugins/org.musicfs.qq.zip' },
  { id: 'org.musicfs.netease', path: 'dist/netease/org.musicfs.netease.zip' }
] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema: z.ZodType<ReleaseIdentity> = z.object({
  version: z.string().min(1), apiVersion: z.string().min(1),
  source: z.object({ revision: z.string().min(1), digest: hash, dirty: z.boolean() }).strict(),
  webDigest: hash.nullable(), plugins: z.array(z.object({ id: z.string().min(1), version: z.string().min(1), revision: hash }).strict())
}).strict();
const desktopSchema = z.object({ target: z.enum(targets), entrypoint: z.literal('src/desktop.ts'), executable: z.string().min(1), executableSha256: hash, identity: identitySchema });
const workerSchema = z.object({ entrypoint: z.literal('src/worker.ts'), identity: identitySchema, plugins: z.array(z.object({
  manifest: z.object({ id: z.string(), version: z.string() }), revision: hash
})) });
const metadataSchema = z.object({ kind: z.literal('plugin-author-kit'), identity: identitySchema });
type ReleaseFile = { file: string; bytes: number; sha256: string };
type Archive = ReleaseFile & { kind: 'desktop' | 'worker' | 'plugin-author-kit'; target?: Target };

function version(value: string): string {
  if (valid(value) !== value) throw new Error(`Release version is not a canonical semantic version: ${value}`);
  return value;
}
async function digest(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}
async function describe(path: string, file: string): Promise<ReleaseFile> {
  return { file, bytes: (await lstat(path)).size, sha256: await digest(path) };
}
const sortedPlugins = (plugins: ReleaseIdentity['plugins']) => plugins.map(({ id, version, revision }) => ({ id, version, revision }))
  .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function assertSource(identity: ReleaseIdentity, current: Awaited<ReturnType<typeof currentSourceIdentity>>, label: string) {
  if (identity.version !== current.version || identity.apiVersion !== current.apiVersion || identity.source.digest !== current.source.digest) {
    throw new Error(`${label} was built from different source inputs. Rebuild it before packaging.`);
  }
}
function assertRuntime(identity: ReleaseIdentity, reference: ReleaseIdentity, label: string) {
  if (identity.webDigest === null || identity.webDigest !== reference.webDigest
    || JSON.stringify(sortedPlugins(identity.plugins)) !== JSON.stringify(sortedPlugins(reference.plugins))) {
    throw new Error(`${label} does not contain the same WebUI and plugin revisions as the other release artifacts.`);
  }
}
async function pluginManifest(path: string): Promise<{ id: string; version: string }> {
  const reader = new ZipReader(new BlobReader(Bun.file(path)), { useWebWorkers: false, useCompressionStream: false, checkSignature: true });
  try {
    const manifests = (await reader.getEntries()).filter(entry => entry.filename === 'manifest.json' && !entry.directory);
    const manifest = manifests[0];
    if (manifests.length !== 1 || !manifest || manifest.directory) throw new Error(`Expected one plugin manifest: ${path}`);
    return z.object({ id: z.string().min(1), version: z.string().min(1) }).parse(JSON.parse(await manifest.getData(new TextWriter())));
  } finally { await reader.close(); }
}

/** Existing generated roots only; streams files directly to the archive and retains their Unix modes. */
async function archive(directory: string, stem: string, staging: string): Promise<ReleaseFile> {
  const file = `${stem}.zip`; const destination = join(staging, file);
  const output = createWriteStream(destination, { flags: 'wx' });
  const writer = new ZipWriter(Writable.toWeb(output), { useWebWorkers: false, bufferedWrite: false, level: 6 });
  async function add(path: string, name: string): Promise<void> {
    const info = await lstat(path);
    if (info.isDirectory()) {
      await writer.add(`${name}/`, undefined, { directory: true, unixMode: info.mode & 0xffff, lastModDate: info.mtime });
      const children = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const child of children) {
        // An author kit may have been used locally; installed dependencies and host state are not release inputs.
        if (['node_modules', 'dev-data', '.wrangler'].includes(child.name)) continue;
        await add(join(path, child.name), `${name}/${child.name}`);
      }
    } else if (info.isFile()) {
      await writer.add(name, new BlobReader(Bun.file(path)), { unixMode: info.mode & 0xffff, lastModDate: info.mtime });
    } else throw new Error(`Release roots must contain generated files and directories only: ${path}`);
  }
  try { await add(directory, stem); await writer.close(); }
  catch (error) { output.destroy(); await finished(output).catch(() => {}); throw error; }
  return describe(destination, file);
}

async function main() {
  const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: { targets: { type: 'string' } } });
  const selected = values.targets === undefined ? [...targets] : values.targets.split(',').map(item => item.trim());
  if (!selected.length || selected.some(item => !targets.includes(item as Target)) || new Set(selected).size !== selected.length) {
    throw new Error(`Use --targets with a comma-separated selection of: ${targets.join(', ')}`);
  }
  const current = await currentSourceIdentity(); const releaseVersion = version(current.version);
  const desktop = await Promise.all((selected as Target[]).map(async target => {
    const directory = resolve('dist/desktop', target);
    const metadata = desktopSchema.parse(await Bun.file(join(directory, 'release.json')).json());
    if (metadata.target !== target) throw new Error(`Desktop target metadata does not match its directory: ${target}`);
    assertSource(metadata.identity, current, target);
    if (await digest(join(directory, metadata.executable)) !== metadata.executableSha256) throw new Error(`Desktop executable checksum mismatch: ${target}`);
    return { directory, target, identity: metadata.identity };
  }));
  const workerDirectory = resolve('dist/worker');
  const worker = workerSchema.parse(await Bun.file(join(workerDirectory, 'bundle.json')).json());
  assertSource(worker.identity, current, 'Worker');
  const reference = desktop[0]!.identity;
  for (const item of desktop) assertRuntime(item.identity, reference, item.target);
  assertRuntime(worker.identity, reference, 'Worker');
  const workerPlugins = worker.plugins.map(item => ({ id: item.manifest.id, version: item.manifest.version, revision: item.revision }));
  if (JSON.stringify(sortedPlugins(workerPlugins)) !== JSON.stringify(sortedPlugins(reference.plugins))) {
    throw new Error('Worker module inventory does not match its release plugin identity.');
  }
  const kitDirectory = resolve('dist/plugin-author-kit');
  const kit = metadataSchema.parse(await Bun.file(join(kitDirectory, 'release.json')).json());
  assertSource(kit.identity, current, 'Plugin author kit');
  if (kit.identity.webDigest !== null || kit.identity.plugins.length) throw new Error('The author kit must have its own source-only identity.');

  const plugins = await Promise.all(pluginInputs.map(async input => {
    const manifest = await pluginManifest(input.path); const revision = await digest(input.path);
    if (manifest.id !== input.id) throw new Error(`Unexpected plugin ID in ${input.path}`);
    return { id: manifest.id, version: version(manifest.version), revision, path: input.path };
  }));
  if (JSON.stringify(sortedPlugins(plugins)) !== JSON.stringify(sortedPlugins(reference.plugins))) {
    throw new Error('The standalone plugin ZIPs do not match the runtime release identities.');
  }
  for (const item of desktop) for (const plugin of plugins) {
    if (await digest(join(item.directory, 'plugins', `${plugin.id}.zip`)) !== plugin.revision) {
      throw new Error(`${item.target} contains a different ${plugin.id} plugin ZIP.`);
    }
  }
  for (const plugin of plugins) {
    if (await digest(join(workerDirectory, 'plugin-packages', `${plugin.id}.zip`)) !== plugin.revision) {
      throw new Error(`Worker contains a different ${plugin.id} installation ZIP.`);
    }
  }

  const directory = resolve('dist/releases'); await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, '.packaging-'));
  try {
    const archives: Archive[] = [];
    for (const item of desktop) archives.push({ ...await archive(item.directory, `musicfs-${releaseVersion}-${item.target}`, staging), kind: 'desktop', target: item.target });
    archives.push({ ...await archive(workerDirectory, `musicfs-${releaseVersion}-worker`, staging), kind: 'worker' });
    archives.push({ ...await archive(kitDirectory, `musicfs-${releaseVersion}-plugin-author-kit`, staging), kind: 'plugin-author-kit' });
    const pluginFiles: (ReleaseFile & { id: string; version: string; revision: string })[] = [];
    await mkdir(join(staging, 'plugins'));
    for (const plugin of plugins) {
      const file = `plugins/${plugin.id}-${plugin.version}.zip`; const path = join(staging, file);
      await cp(plugin.path, path);
      const copied = await describe(path, file);
      if (copied.sha256 !== plugin.revision) throw new Error(`Plugin changed while packaging: ${plugin.id}`);
      pluginFiles.push({ ...copied, id: plugin.id, version: plugin.version, revision: plugin.revision });
    }
    const manifest = { formatVersion: 1, generatedAt: new Date().toISOString(), identity: reference, archives, plugins: pluginFiles };
    await Bun.write(join(staging, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const manifestFile = await describe(join(staging, 'release-manifest.json'), 'release-manifest.json');
    const checksums = [...archives, ...pluginFiles, manifestFile].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
      .map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n';
    await Bun.write(join(staging, 'SHA256SUMS'), checksums);
    await mkdir(join(directory, 'plugins'), { recursive: true });
    for (const item of [...archives, ...pluginFiles, manifestFile]) await rename(join(staging, item.file), join(directory, item.file));
    await rename(join(staging, 'SHA256SUMS'), join(directory, 'SHA256SUMS'));
    console.log(JSON.stringify({ directory, version: releaseVersion, sourceDigest: reference.source.digest,
      archives: archives.map(item => ({ file: item.file, bytes: item.bytes, sha256: item.sha256 })),
      plugins: pluginFiles.map(item => ({ file: item.file, bytes: item.bytes, sha256: item.sha256 })), targetRuntimeVerified: false }));
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (import.meta.main) await main();
