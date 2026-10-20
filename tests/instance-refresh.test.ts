import { afterEach, expect, test } from 'bun:test';
import type { Entry, SourcePlugin } from '@musicfs/plugin-api';
import { createExtensions } from '../src/core/extensions';
import { createManagementApi } from '../src/transport/http';
import { createApi } from '../src/web/api';
import { libraryFixture } from './helpers/library-fixture';
import { createLibrary } from '../src/core/library';
import { completeRefresh, driveRefresh } from '../scripts/helpers/refresh-http';
import type { RefreshView } from '../src/contracts/refreshes';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const signal = () => new AbortController().signal;
const directory = (ref: string, name = ref): Entry => ({ kind: 'directory', entryId: ref, name, directoryRef: ref });
const file = (name: string): Entry => ({ kind: 'file', entryId: name, name, fileRef: name });

async function setup() {
  const content = new Map<string, Entry[]>([['collection', [directory('cached', '已浏览'), directory('lazy')]], ['cached', [file('old.wav')]], ['lazy', []]]);
  const calls: string[] = []; const failures = new Set<string>();
  const source: SourcePlugin = {
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, candidate) => ({ ok: true, value: candidate }),
    roots: async () => ({ ok: true, value: { items: [{ sourceId: 'collection', name: '集合', directoryRef: 'collection' }] } }),
    list: async (_ctx, ref) => {
      calls.push(ref);
      return failures.has(ref) ? { ok: false, error: { kind: 'temporary', message: 'Fixture upstream unavailable' } }
        : { ok: true, value: { items: content.get(ref) ?? [] } };
    },
    stat: async () => ({ ok: false, error: { kind: 'not_supported', message: 'Unused' } }),
    open: async () => ({ ok: false, error: { kind: 'not_supported', message: 'Unused' } })
  };
  const f = await libraryFixture(source); cleanups.push(f.close);
  const installation = f.store.installations()[0]!;
  const extensions = createExtensions(f.store, async () => {});
  const http = createManagementApi({ host: 'desktop', adminToken: 'fixture-admin', sources: f.sources, library: f.library,
    extensions, remove: id => extensions.remove(id), maxPackageBytes: 1024, install: async () => installation });
  const fetcher = ((input, init) => http.request(new Request(new URL(String(input), 'http://fixture'), init))) as typeof fetch;
  const finish = (view: RefreshView) => driveRefresh((url: string, init?: RequestInit) => fetcher(url, init), view, 'http://fixture', { Authorization: 'Bearer fixture-admin' });
  return { ...f, source, content, calls, failures, api: createApi('fixture-admin', fetcher), http, finish };
}

test('the WebUI refresh action updates cached song directories, with new child directories left lazy', async () => {
  const f = await setup();
  const path = '/实例 & #/集合/已浏览';
  expect((await f.library.files.list(path, signal())).map(item => item.name)).toEqual(['old.wav']);
  f.content.set('cached', [file('new.wav')]); f.calls.length = 0;
  await f.finish(await f.api.startRefresh(f.id, { kind: 'instance' }));
  expect((await f.library.files.list(path, signal())).map(item => item.name)).toEqual(['new.wav']);
  expect(f.calls).toEqual(['collection', 'cached']);
  expect(f.store.snapshot(f.id, { kind: 'directory', ref: 'lazy' })).toBeUndefined();
});

test('instance refresh reports partial failure, keeps last complete content and never rewrites the layout', async () => {
  const f = await setup();
  await f.library.files.list('/实例 & #/集合/已浏览', signal());
  const before = f.store.snapshot(f.id, { kind: 'directory', ref: 'cached' });
  const layout = await f.library.saveLayout(0, [{ kind: 'source', id: 'export', name: '我的导出', instanceId: f.id, sourceId: 'collection' }]);
  f.failures.add('cached'); f.content.set('collection', [directory('cached', '已浏览'), directory('new')]);
  const result = await f.finish(await f.api.startRefresh(f.id, { kind: 'instance' }));
  expect(result).toMatchObject({ refreshedDirectories: 1, failures: [{ directoryRef: 'cached', error: { code: 'source_failed', sourceFault: { kind: 'temporary' } } }] });
  expect(f.store.snapshot(f.id, { kind: 'directory', ref: 'cached' })?.value).toEqual(before?.value);
  expect(f.store.snapshot(f.id, { kind: 'directory', ref: 'cached' })?.error).toBe('temporary');
  expect(await f.library.layout()).toEqual(layout);
  expect((await f.library.files.list('/我的导出/已浏览', signal())).map(item => item.name)).toEqual(['old.wav']);
  f.failures.clear(); f.content.set('cached', [file('recovered.wav')]);
  expect((await f.finish(await f.api.startRefresh(f.id, { kind: 'instance' }))).failures).toEqual([]);
  expect((await f.library.files.list('/我的导出/已浏览', signal())).map(item => item.name)).toEqual(['recovered.wav']);
});

test('directory failure remains visible through management after another directory succeeds and controllers reopen', async () => {
  const f = await setup();
  f.source.roots = async () => ({ ok: true, value: { items: [
    { sourceId: 'a', name: '目录 A', directoryRef: 'cached' },
    { sourceId: 'b', name: '目录 B', directoryRef: 'lazy' }
  ] } });
  const path = '/实例 & #/目录 A';
  expect((await f.api.library(path, signal())).map(item => item.name)).toEqual(['old.wav']);
  const previous = await f.api.directoryStatus(f.id, 'cached', signal());
  if (!previous) throw new Error('Missing initial directory status');
  expect(previous?.error).toBeNull();
  f.failures.add('cached');
  const failed = await f.api.startRefresh(f.id, { kind: 'directory', directoryRef: 'cached' });
  expect(await f.api.stepRefresh(failed.operationId)).toMatchObject({ status: 'failed' });
  expect(await f.api.directoryStatus(f.id, 'cached', signal())).toEqual({ ...previous, error: 'temporary' });
  const other = await f.finish(await f.api.startRefresh(f.id, { kind: 'directory', directoryRef: 'lazy' }));
  expect(other.status).toBe('completed');
  expect((await f.api.currentRefresh(f.id, signal()))?.operationId).toBe(other.operationId);

  const library = createLibrary(f.sources, f.store, undefined, { execution: 'deferred' });
  const extensions = createExtensions(f.store, async () => {});
  const reopened = createManagementApi({ host: 'desktop', adminToken: 'fixture-admin', sources: f.sources, library,
    extensions, remove: id => extensions.remove(id), maxPackageBytes: 1024, install: async () => f.store.installations()[0]! });
  const get = (url: string) => reopened.request(url, { headers: { Authorization: 'Bearer fixture-admin' } });
  const statusPath = `/api/instances/${f.id}/directory-status?directoryRef=cached`;
  const status = await get(statusPath);
  expect(status.status).toBe(200); expect(await status.json()).toEqual({ ...previous, error: 'temporary' });
  expect(await (await get(`/api/instances/${f.id}/directory-status?directoryRef=lazy`)).json()).toMatchObject({ error: null });
  const oldContent = await get(`/api/library?path=${encodeURIComponent(path)}`);
  expect(oldContent.status).toBe(200);
  expect((await oldContent.json() as { name: string }[]).map(item => item.name)).toEqual(['old.wav']);

  f.failures.clear(); f.content.set('cached', [file('recovered.wav')]);
  expect((await f.finish(await f.api.startRefresh(f.id, { kind: 'directory', directoryRef: 'cached' }))).status).toBe('completed');
  expect(await (await get(statusPath)).json()).toMatchObject({ error: null });
  expect((await (await get(`/api/library?path=${encodeURIComponent(path)}`)).json() as { name: string }[]).map(item => item.name)).toEqual(['recovered.wav']);
});

test('instance refresh skips unreachable old snapshots, isolates instances and visits cycles only once', async () => {
  const f = await setup();
  await f.library.files.list('/实例 & #/集合/已浏览', signal());
  await f.library.refresh(f.id, 'removed', signal());
  const other = await f.sources.create('org.musicfs.sample', '另一个实例', {}, signal());
  if (!other.ok) throw new Error('Fixture creation failed');
  await f.library.refresh(other.value.id, 'cached', signal());
  const otherSnapshot = f.store.snapshot(other.value.id, { kind: 'directory', ref: 'cached' });
  f.content.set('cached', [directory('collection')]); f.calls.length = 0;
  expect(await f.finish(await f.api.startRefresh(f.id, { kind: 'instance' }))).toMatchObject({ status: 'completed', refreshedDirectories: 2, failures: [] });
  expect(f.calls).toEqual(['collection', 'cached']);
  expect(f.store.snapshot(other.value.id, { kind: 'directory', ref: 'cached' })).toEqual(otherSnapshot);
});

test('directory refresh is narrow, and the legacy empty request still refreshes only roots', async () => {
  const f = await setup();
  await f.finish(await f.api.startRefresh(f.id, { kind: 'directory', directoryRef: 'cached' })); expect(f.calls).toEqual(['cached']);
  f.calls.length = 0;
  const legacy = await f.http.request(`/api/instances/${f.id}/refresh`, { method: 'POST', headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' }, body: '{}' });
  expect(legacy.status).toBe(202);
  await completeRefresh(async (url, init) => f.http.request(url, init), legacy, 'http://fixture', { Authorization: 'Bearer fixture-admin' }); expect(f.calls).toEqual([]);
  const invalid = await f.http.request(`/api/instances/${f.id}/refresh`, { method: 'POST', headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'instance', directoryRef: 'cached' }) });
  expect(invalid.status).toBe(400);
});

test('configuration changes and cancellation abort the batch before publishing old content', async () => {
  for (const change of ['configuration', 'cancellation'] as const) {
    const f = await setup(); await f.library.files.list('/实例 & #/集合/已浏览', signal());
    const before = f.store.snapshot(f.id, { kind: 'directory', ref: 'cached' });
    const controller = new AbortController();
    const pending = Promise.withResolvers<void>(); const started = Promise.withResolvers<void>();
    const original = f.source.list;
    f.source.list = async (ctx, ref, cursor) => {
      if (ref === 'cached') { started.resolve(); await pending.promise; }
      return original(ctx, ref, cursor);
    };
    const work = f.library.refreshInstance(f.id, controller.signal);
    // Observe rejection immediately, without making the assertion wait before we release the read.
    const observed = work.then(() => null, (error: unknown) => error);
    await started.promise;
    if (change === 'configuration') await f.sources.configure(f.id, { revision: 2 }, signal());
    else controller.abort(new Error('fixture-cancelled'));
    pending.resolve(); expect(await observed).toBeInstanceOf(Error);
    expect(f.store.snapshot(f.id, { kind: 'directory', ref: 'cached' })?.value).toEqual(before?.value);
  }
});

test('instance refresh has an explicit directory budget', async () => {
  const f = await setup(); await f.library.files.list('/实例 & #/集合/已浏览', signal());
  const bounded = createLibrary(f.sources, f.store, { pages: 1000, entries: 100_000, directories: 1 });
  await expect(bounded.refreshInstance(f.id, signal())).rejects.toMatchObject({ code: 'invalid_source' });
});

test('the management caller gets plugin-defined labels and cached counters without leaking source stamps', async () => {
  const f = await setup(); f.source.statistics = { records: '项目' };
  f.source.list = async () => ({ ok: true, value: { items: [], statistics: { records: 7 } } });
  expect(await f.api.directoryStatus(f.id, 'collection', signal())).toBeNull();
  await f.finish(await f.api.startRefresh(f.id, { kind: 'directory', directoryRef: 'collection' }));
  expect((await f.api.configuration('org.musicfs.sample', signal())).statistics).toEqual({ records: '项目' });
  const status = await f.api.directoryStatus(f.id, 'collection', signal());
  expect(status?.statistics).toEqual({ records: 7 });
  expect(Object.keys(status ?? {}).sort()).toEqual(['completedAt', 'error', 'statistics']);
});
