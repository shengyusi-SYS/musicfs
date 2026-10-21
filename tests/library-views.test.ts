import { expect, test } from 'bun:test';
import type { SourcePlugin } from '@musicfs/plugin-api';
import { createLibrary, type LibraryStore, type Snapshot, type SnapshotKey } from '../src/core/library';
import { createPublishedViews } from '../src/core/library/published-views';
import type { SourceStamp } from '../src/core/sources';
import { createDav } from '../src/transport/dav';
import { libraryFixture } from './helpers/library-fixture';

const signal = () => new AbortController().signal;
const stamp: SourceStamp = { id: 'instance', pluginId: 'org.musicfs.sample', epoch: 1, pluginRevision: 'a'.repeat(64), pluginGeneration: 1 };
const key = (ref: string): SnapshotKey => ({ kind: 'directory', ref });
const snapshot = (id: string): Snapshot => ({ stamp, id, kind: 'directory', completedAt: '2026-10-21T00:00:00.000Z', items: [
  { kind: 'file', entryId: id, name: `${id}.wav`, fileRef: id }
] });
const project = (value: Snapshot) => value.kind === 'directory' ? value.items.map(item => ({ id: item.entryId, name: item.name })) : [];
const ensure = async (): Promise<Snapshot> => { throw new Error('Fixture snapshot is already published'); };

test('4000-file HEAD, GET and Range requests share one published path index', async () => {
  const info = { contentId: 'fixed', size: 8, mediaType: 'audio/wav' };
  const source: SourcePlugin = {
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, value) => ({ ok: true, value }),
    roots: async () => ({ ok: true, value: { items: [{ sourceId: 'root', name: '音乐', directoryRef: 'root' }] } }),
    list: async () => ({ ok: true, value: { items: Array.from({ length: 4000 }, (_, index) => ({
      kind: 'file' as const, entryId: String(index), name: `${String(index).padStart(4, '0')}.wav`, fileRef: String(index), info
    })) } }),
    stat: async () => ({ ok: true, value: info }),
    open: async (_ctx, _file, request) => ({ ok: true, value: { content: info, servedRange: request.range ?? null,
      body: new Blob([request.range ? 'CD' : 'ABCDEFGH']).stream() } })
  };
  const fixture = await libraryFixture(source);
  try {
    await fixture.library.refresh(fixture.id, undefined, signal());
    await fixture.library.refresh(fixture.id, 'root', signal());
    // A new controller also models a Worker isolate with no retained view; it reads durable snapshots first.
    const library = createLibrary(fixture.sources, fixture.store);
    const app = createDav(library.files, { username: 'reader', password: 'fixture' });
    const read = fixture.store.snapshot; let reads = 0; let loadedItems = 0;
    fixture.store.snapshot = (...args) => { const result = read(...args); reads++; loadedItems += result?.value?.items.length ?? 0; return result; };
    const request = (index: number, method: string, headers: Record<string, string> = {}) => app.fetch(new Request(
      `http://fixture/dav/${encodeURIComponent('实例 & #')}/${encodeURIComponent('音乐')}/${String(index).padStart(4, '0')}.wav`,
      { method, headers: { Authorization: `Basic ${btoa('reader:fixture')}`, ...headers } }
    ));
    for (const index of [0, 100, 999, 2000, 3999]) {
      const response = await request(index, 'HEAD');
      expect(response.status).toBe(200); expect(response.headers.get('Content-Length')).toBe('8');
    }
    expect(reads).toBe(2); expect(loadedItems).toBe(4001);
    expect(await (await request(2000, 'GET')).text()).toBe('ABCDEFGH');
    const range = await request(3999, 'GET', { Range: 'bytes=2-3' });
    expect(range.status).toBe(206); expect(await range.text()).toBe('CD');
    expect(reads).toBe(2); expect(loadedItems).toBe(4001);
    // Another cold controller retains correctness without the previous controller's memory.
    const cold = createLibrary(fixture.sources, fixture.store);
    expect(await cold.files.stat('/实例 & #/音乐/3999.wav', signal())).toMatchObject({ kind: 'file' });
    expect(reads).toBe(4); expect(loadedItems).toBe(8002);
  } finally { fixture.close(); }
});

test('published view changes only after complete publication and failed refresh retains the old index', async () => {
  let name = 'old.wav'; let fail = false;
  const source: SourcePlugin = {
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, value) => ({ ok: true, value }),
    roots: async () => ({ ok: true, value: { items: [{ sourceId: 'root', name: '音乐', directoryRef: 'root' }] } }),
    list: async () => fail ? { ok: false, error: { kind: 'unavailable', message: 'Fixture unavailable' } }
      : { ok: true, value: { items: [{ kind: 'file', entryId: 'track', name, fileRef: 'track' }] } },
    stat: async () => ({ ok: true, value: { contentId: 'fixed', size: 8, mediaType: 'audio/wav' } }),
    open: async () => { throw new Error('No audio request in this fixture'); }
  };
  const fixture = await libraryFixture(source);
  try {
    const { library, id } = fixture;
    const [old] = await library.files.list('/实例 & #/音乐', signal());
    name = 'new.wav'; await library.refresh(id, 'root', signal());
    await expect(library.files.stat('/实例 & #/音乐/old.wav', signal())).rejects.toMatchObject({ code: 'not_found' });
    expect(await library.files.stat('/实例 & #/音乐/new.wav', signal())).toMatchObject({ kind: 'file' });
    const read = fixture.store.snapshot; let reads = 0;
    fixture.store.snapshot = (...args) => { reads++; return read(...args); };
    fail = true; await expect(library.refresh(id, 'root', signal())).rejects.toThrow('Fixture unavailable');
    expect(await library.files.stat('/实例 & #/音乐/new.wav', signal())).toMatchObject({ kind: 'file' });
    expect(reads).toBe(0);
    await fixture.sources.configure(id, { changed: true }, signal());
    await expect(library.files.stat(old!, signal())).rejects.toMatchObject({ code: 'stale_call' });
  } finally { fixture.close(); }
});

test('concurrent cold lookups build one view and a cancelled caller does not abort other lookups', async () => {
  const value = snapshot('one'); const pending = Promise.withResolvers<{ value: Snapshot; error: null }>(); let reads = 0; let builds = 0;
  const store: Pick<LibraryStore, 'snapshot' | 'snapshotHeader'> = {
    snapshotHeader: () => ({ ...value, error: null }),
    snapshot: () => { reads++; return pending.promise; }
  };
  const views = createPublishedViews(store, ensure, value => { builds++; return project(value); });
  const aborted = new AbortController();
  const first = views.get(stamp, key('one'), aborted.signal);
  const second = views.get(stamp, key('one'), signal());
  aborted.abort(); pending.resolve({ value, error: null });
  await expect(first).rejects.toThrow();
  expect((await second).byName.get('one.wav')?.id).toBe('one');
  expect(reads).toBe(1); expect(builds).toBe(1);
});

test('bounded views evict least-recently used entries and oversized directories remain usable', async () => {
  let reads = 0;
  const store: Pick<LibraryStore, 'snapshot' | 'snapshotHeader'> = {
    snapshotHeader: (_id, key) => ({ ...snapshot(key.ref), error: null }),
    snapshot: (_id, key) => { reads++; return { value: snapshot(key.ref), error: null }; }
  };
  const views = createPublishedViews(store, ensure, project, { views: 2, estimatedBytes: 100_000 });
  for (const ref of ['a', 'b', 'a', 'c', 'b']) await views.get(stamp, key(ref), signal());
  expect(reads).toBe(4);
  const small = createPublishedViews(store, ensure, project, { views: 2, estimatedBytes: 100 });
  for (let index = 0; index < 2; index++) expect((await small.get(stamp, key('a'), signal())).entries[0]?.pathName).toBe('a.wav');
  expect(reads).toBe(6);
});

test('publication between header and row reads retries against the new durable identity', async () => {
  let headers = 0; let reads = 0;
  const store: Pick<LibraryStore, 'snapshot' | 'snapshotHeader'> = {
    snapshotHeader: () => ({ ...snapshot(++headers === 1 ? 'old' : 'new'), error: null }),
    snapshot: () => { reads++; return { value: snapshot('new'), error: null }; }
  };
  const views = createPublishedViews(store, ensure, project);
  expect((await views.get(stamp, key('root'), signal())).entries[0]?.pathName).toBe('new.wav');
  expect(headers).toBe(2); expect(reads).toBe(2);
});
