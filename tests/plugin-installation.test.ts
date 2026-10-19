import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipWriter, Uint8ArrayWriter, TextReader } from '@zip.js/zip.js/index-native.js';
import { zipSync, unzipSync } from 'fflate';
import { createExtensions, parseManifest } from '../src/core/extensions';
import { createSources } from '../src/core/sources';
import { readPackage } from '../src/infrastructure/archives';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import { createDesktopPlugins } from '../src/hosts/desktop/plugins';
import { buildSample } from '../scripts/build-sample';
import manifest from '../plugins/sample/manifest.json';

let archive: Uint8Array;
const cleanups: (() => Promise<void>)[] = [];
const signal = () => new AbortController().signal;
beforeAll(async () => { archive = await buildSample(); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-test-'));
  const db = openSqlite(join(directory, 'state.sqlite'));
  cleanups.push(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const host = createDesktopPlugins(join(directory, 'plugins'), db);
  const extensions = createExtensions(db, host.prepare);
  const sources = createSources(db, host.registry);
  const prepared = await readPackage(archive, 'desktop', signal());
  await extensions.install(prepared);
  return { directory, db, host, extensions, sources, prepared };
}

describe('prebuilt plugin packages and desktop instances', () => {
  test('loads the installed ESM, validates settings, and keeps two instances independent', async () => {
    const { sources } = await setup();
    expect((await sources.create(manifest.id, 'invalid', { label: '' }, signal())).ok).toBe(false);
    const a = await sources.create(manifest.id, 'A', { label: '服务器甲' }, signal());
    const b = await sources.create(manifest.id, 'B', { label: '服务器乙' }, signal());
    if (!a.ok || !b.ok) throw new Error('Fixture creation failed');
    expect((await sources.roots(a.value.id, signal()))).toMatchObject({ ok: true, value: { items: [{ name: '服务器甲' }] } });
    await sources.configure(a.value.id, { label: '已修改' }, signal());
    expect((await sources.roots(b.value.id, signal()))).toMatchObject({ ok: true, value: { items: [{ name: '服务器乙' }] } });
    const stat = await sources.stat(a.value.id, 'tone', signal());
    if (!stat.ok) throw new Error('No sample metadata');
    const read = await sources.open(a.value.id, 'tone', { expectedContentId: stat.value.contentId, range: { start: 0, end: 3 } }, signal());
    if (!read.ok) throw new Error('No sample bytes');
    expect(read.value.servedRange).toEqual({ start: 0, end: 3 });
    expect(await new Response(read.value.body).text()).toBe('RIFF');
  });

  test('removal retains instances, stops reads, and compatible reinstallation restores them', async () => {
    const { sources, extensions, prepared, db } = await setup();
    const instance = await sources.create(manifest.id, 'retained', { label: '保留' }, signal());
    if (!instance.ok) throw new Error('Fixture creation failed');
    await extensions.remove(manifest.id);
    expect(await sources.instances()).toHaveLength(1);
    expect(db.capture(instance.value.id)).toBeUndefined();
    await expect(sources.roots(instance.value.id, signal())).rejects.toMatchObject({ code: 'missing_instance' });
    await extensions.install(prepared);
    expect(await sources.roots(instance.value.id, signal())).toMatchObject({ ok: true, value: { items: [{ name: '保留' }] } });
    await sources.delete(instance.value.id);
    await extensions.install(prepared);
    expect(await sources.instances()).toHaveLength(0);
  });

  test('a failed candidate module leaves the previous installation usable', async () => {
    const { sources, extensions, prepared, db } = await setup();
    const current = db.installation(manifest.id);
    const files = new Map(prepared.files);
    files.set('index.mjs', new TextEncoder().encode('export default {}'));
    const candidate = { ...prepared, manifest: { ...prepared.manifest, version: '0.1.1' }, digest: 'f'.repeat(64), files };
    await expect(extensions.install(candidate)).rejects.toMatchObject({ code: 'invalid_package' });
    expect(db.installation(manifest.id)).toEqual(current);
    expect((await sources.create(manifest.id, 'still works', { label: '旧版本' }, signal())).ok).toBe(true);
  });
});

describe('package and compatibility checks', () => {
  test('rejects incompatible API/host, invalid versions, and ambiguous paths', () => {
    for (const invalid of [
      { ...manifest, apiRange: '^2.0.0' }, { ...manifest, version: 'latest' },
      { ...manifest, hosts: { worker: 'index.mjs' } },
      { ...manifest, files: ['index.mjs', 'INDEX.MJS'] },
      { ...manifest, files: ['../escape.mjs'] }
    ]) expect(() => parseManifest(invalid, 'desktop')).toThrow();
  });

  test('zip.js reads a package compressed by fflate; fflate decodes the sample package', async () => {
    const decoded = unzipSync(archive);
    const recompressed = zipSync(decoded);
    expect((await readPackage(recompressed, 'desktop', signal())).manifest.id).toBe(manifest.id);
    expect(Object.keys(decoded).sort()).toEqual(['LICENSE.txt', 'config.schema.json', 'index.mjs', 'manifest.json']);
  });

  test('rejects undeclared files, traversal and actual decompression budget overflow', async () => {
    const files = unzipSync(archive);
    for (const filename of ['../escape.mjs', 'extra.mjs']) {
      await expect(readPackage(zipSync({ ...files, [filename]: new Uint8Array([1]) }), 'desktop', signal())).rejects.toThrow();
    }
    await expect(readPackage(archive, 'desktop', signal(), { compressedBytes: 100_000, totalBytes: 1024, entryBytes: 100_000, entries: 100 })).rejects.toThrow();
  });

  test('rejects symlinks and duplicate entries through the archive library', async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: false });
    await writer.add('link', new TextReader('../escape'), { unixMode: 0o120777 });
    await expect(readPackage(await writer.close(), 'desktop', signal())).rejects.toThrow();
    const duplicate = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: false });
    await duplicate.add('first.mjs', new TextReader('a'));
    await duplicate.add('FIRST.MJS', new TextReader('b'));
    await expect(readPackage(await duplicate.close(), 'desktop', signal())).rejects.toThrow();
  });
});
