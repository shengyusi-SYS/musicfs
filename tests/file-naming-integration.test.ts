import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Log, LogLevel, Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { Entry, FileInfo, SourcePlugin } from '@musicfs/plugin-api';
import { DEFAULT_TEMPLATE_POLICY, type FileNamingPolicy, type FileNamingPreview } from '../src/contracts/file-naming';
import { parseManifest } from '../src/core/extensions';
import { createLibrary } from '../src/core/library';
import { createSources } from '../src/core/sources';
import { createD1Store } from '../src/infrastructure/persistence/d1';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import { createDav } from '../src/transport/dav';
import { createManagementApi } from '../src/transport/http';
import manifest from '../plugins/sample/manifest.json';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
const policy = (template: string): FileNamingPolicy => ({ ...DEFAULT_TEMPLATE_POLICY, template });
const original: FileNamingPolicy = { mode: 'original' };
const directoryKey = (ref: string) => ({ kind: 'directory' as const, ref });

async function setup(adapter: 'SQLite' | 'D1') {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-file-naming-'));
  let store: ReturnType<typeof openSqlite> | ReturnType<typeof createD1Store>; let reopen: () => void;
  if (adapter === 'SQLite') {
    const path = join(directory, 'state.sqlite'); let db = openSqlite(path); store = db;
    reopen = () => { db.close(); db = openSqlite(path); store = db; };
    cleanups.push(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  } else {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("naming fixture")}}',
      compatibilityDate: '2026-07-30', d1Databases: { DB: 'file-naming-tests' }, d1Persist: directory, log: new Log(LogLevel.ERROR) });
    cleanups.push(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()).replace(/^[\s]*--.*$/gm, '').replaceAll('\n', ' '));
    }
    store = createD1Store(db); reopen = () => { store = createD1Store(db); };
  }
  const installation = await store.activate(parseManifest(manifest, 'desktop'), 'a'.repeat(64), null);
  const bytes = new TextEncoder().encode('0123456789audio'); const calls = { roots: 0, list: 0, stat: 0, open: 0 };
  const info = (id: string): FileInfo => ({ contentId: `immutable:${id}`, size: bytes.length, mediaType: 'audio/mpeg', modifiedAt: '2020-01-01T00:00:00.000Z' });
  const entries: Entry[] = ['one', 'two'].map((id, index) => ({ kind: 'file', entryId: `${index}:${id}`, name: `000${index + 1} Original-${id}.mp3`, fileRef: id,
    info: info(id), naming: { identity: id, fields: { title: 'Same', artist: ['Artist'], id, index: index + 1 } } }));
  const plugin: SourcePlugin = {
    configuration: { schema: { type: 'object' } }, naming: { fields: { title: '歌名', artist: '歌手', id: '编号', index: '目录序号' } },
    validateConfig: async (_ctx, value) => ({ ok: true, value }),
    roots: async () => { calls.roots++; return { ok: true, value: { items: [
      { sourceId: 'custom', name: '自定义', directoryRef: 'custom' }, { sourceId: 'music', name: '音乐', directoryRef: 'music' }
    ] } }; },
    list: async () => { calls.list++; return { ok: true, value: { items: structuredClone(entries) } }; },
    stat: async (_ctx, id) => { calls.stat++; return { ok: true, value: info(id) }; },
    open: async (_ctx, id, request) => {
      calls.open++; expect(request.expectedContentId).toBe(info(id).contentId);
      const range = request.range; const body = range ? bytes.slice(range.start, range.end + 1) : bytes;
      return { ok: true, value: { content: info(id), servedRange: range ?? null,
        body: new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }) } };
    }
  };
  const build = () => {
    const sources = createSources(store, { get: async () => ({ ...installation, module: plugin }), isCurrent: async () => true });
    return { sources, library: createLibrary(sources, store, undefined, { execution: 'deferred' }) };
  };
  let services = build();
  const created = await services.sources.create(manifest.id, '实例', {}, signal()); if (!created.ok) throw new Error('Fixture creation failed');
  const id = created.value.id;
  await services.library.refresh(id, undefined, signal());
  // The first completed file directory is deliberately an explicit override in the second scenario.
  await services.library.refresh(id, 'custom', signal()); await services.library.refresh(id, 'music', signal());
  return { id, entries, calls, bytes, get store() { return store; }, get library() { return services.library; }, get sources() { return services.sources; },
    peer: () => build().library, reopen() { reopen(); services = build(); },
    api() { return createManagementApi({ host: 'desktop', adminToken: 'fixture-admin', sources: services.sources, library: services.library,
      extensions: { list: () => store.installations() }, maxPackageBytes: 1024, install: async () => installation, remove: async () => {} }); }
  };
}

for (const adapter of ['SQLite', 'D1'] as const) {
  test(`${adapter}: naming policies persist independent revisions, clear to inheritance and join the published header`, async () => {
    const f = await setup(adapter); const epoch = (await f.sources.view(f.id)).epoch; const baselineCalls = { ...f.calls };
    const title = policy('{{title}}'); const artist = policy('{{artist}} - {{title}}');
    expect(await f.library.naming.get(f.id, 'music')).toMatchObject({ revision: 0, inherited: true, effectivePolicy: original });
    const saved = await f.library.naming.set(f.id, undefined, 0, title); expect(saved.revision).toBe(1);
    await f.library.naming.set(f.id, 'custom', 0, original);
    expect((await f.store.snapshotHeader(f.id, directoryKey('music')))?.fileNamingPolicy).toEqual(title);
    expect((await f.store.snapshotHeader(f.id, directoryKey('custom')))?.fileNamingPolicy).toEqual(original);
    await f.library.naming.set(f.id, 'music', 0, artist);
    expect((await f.store.snapshotHeader(f.id, directoryKey('music')))?.fileNamingPolicy).toEqual(artist);
    const cleared = await f.library.naming.set(f.id, 'music', 1, null);
    expect(cleared).toMatchObject({ revision: 2, policy: null, inherited: true, effectivePolicy: title });
    expect((await f.store.snapshotHeader(f.id, directoryKey('music')))?.fileNamingPolicy).toEqual(title);
    expect((await f.library.naming.set(f.id, undefined, 1, title)).revision).toBe(1);
    expect((await f.library.naming.set(f.id, 'music', 2, null)).revision).toBe(2);
    expect(await f.store.saveFileNamingPolicy(f.id, undefined, 0, original)).toBe(false);
    await expect(f.library.naming.set(f.id, undefined, 0, title)).rejects.toThrow('已变化');
    f.reopen();
    expect(await f.library.naming.get(f.id, 'music')).toMatchObject({ revision: 2, policy: null, inherited: true, effectivePolicy: title });
    expect((await f.store.snapshotHeader(f.id, directoryKey('custom')))?.fileNamingPolicy).toEqual(original);
    expect((await f.sources.view(f.id)).epoch).toBe(epoch); expect(f.calls).toEqual(baselineCalls);
  });

  test(`${adapter}: preview, HTTP apply and DAV use the same names while audio identity and source caches remain stable`, async () => {
    const f = await setup(adapter); const path = '/实例/音乐'; const peer = f.peer();
    const oldEntries = await peer.files.list(path, signal()); const before = await peer.files.stat(oldEntries[0]!, signal());
    if (before.kind !== 'file') throw new Error('Expected file');
    const stamp = await f.sources.view(f.id); const snapshotId = (await f.store.snapshotHeader(f.id, directoryKey('music')))!.id;
    const baselineCalls = { ...f.calls }; await f.library.naming.set(f.id, 'custom', 0, original);
    const api = f.api(); const request = (method: string, suffix: string, body: unknown) => api.request(`/api/instances/${f.id}/file-naming${suffix}`, {
      method, headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const title = policy('{{title}}'); const previewResponse = await request('POST', '/preview', { policy: title });
    expect(previewResponse.status).toBe(200); const preview = await previewResponse.json() as FileNamingPreview;
    expect(preview.directoryRef).toBe('music'); expect(preview.total).toBe(2); expect(preview.changed).toBe(2);
    expect(f.calls).toEqual(baselineCalls);
    const applied = await request('PUT', '', { revision: 0, policy: title }); expect(applied.status).toBe(200); await applied.arrayBuffer();
    const listed = await peer.files.list(path, signal()); expect(listed.map(entry => entry.name)).toEqual(preview.items.map(entry => entry.after));
    const file = await peer.files.stat(listed[0]!, signal()); if (file.kind !== 'file') throw new Error('Expected renamed file');
    expect(file.etag).toBe(before.etag); expect(file.handle).toEqual(before.handle);
    expect(await f.sources.view(f.id)).toEqual(stamp); expect((await f.store.snapshotHeader(f.id, directoryKey('music')))!.id).toBe(snapshotId);
    expect((await f.library.naming.preview(f.id, 'music', title)).changed).toBe(0);
    const dav = createDav(peer.files, { username: 'reader', password: 'fixture' });
    const davPath = '/dav/' + ['实例', '音乐', listed[0]!.name].map(encodeURIComponent).join('/');
    const response = await dav.request(davPath, { headers: { Authorization: 'Basic ' + btoa('reader:fixture'), Range: 'bytes=2-5' } });
    expect(response.status).toBe(206); expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.bytes.slice(2, 6));
    expect(response.headers.get('ETag')).toBe('"' + file.etag + '"');
    await f.library.naming.set(f.id, 'music', 0, policy('{{id}} - {{title}}'));
    const inherit = await f.library.naming.preview(f.id, 'music', null);
    expect(inherit.items.map(entry => entry.after)).toEqual(listed.map(entry => entry.name)); expect(inherit.changed).toBe(2);
    const absent = await f.library.naming.preview(f.id, 'never-visited', title); expect(absent.total).toBe(0);
    expect(f.calls).toEqual({ ...baselineCalls, open: baselineCalls.open + 1 });
  });
}
