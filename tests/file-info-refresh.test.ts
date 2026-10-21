import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Entry, Outcome, Page, SourcePlugin } from '@musicfs/plugin-api';
import { parseManifest, type PluginRegistry } from '../src/core/extensions';
import { createSources } from '../src/core/sources';
import { createRefreshes } from '../src/core/library/refresh';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import rawManifest from '../plugins/sample/manifest.json';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const signal = () => new AbortController().signal;
const directoryRef = 'music';
const key = { kind: 'directory' as const, ref: directoryRef };
const file = (id: string): Extract<Entry, { kind: 'file' }> => ({ kind: 'file', entryId: id, name: `${id}.flac`, fileRef: id });
const complete = (id: string, size = 100): Entry => ({ ...file(id), info: { contentId: `bytes-${id}`, size, mediaType: 'audio/flac',
  modifiedAt: '2026-10-20T00:00:00Z' } });
const deferred = (id: string): Entry => ({ ...file(id), deferredInfo: true });
const page = (items: Entry[], nextCursor?: string): Outcome<Page<Entry>> => ({ ok: true, value: { items,
  ...(nextCursor === undefined ? {} : { nextCursor }) } });

async function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'musicfs-file-info-'));
  const path = join(folder, 'state.sqlite'); let store = openSqlite(path); let now = 1000;
  cleanups.push(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });
  store.activate(parseManifest(rawManifest, 'desktop'), 'a'.repeat(64), null);
  const source: SourcePlugin = {
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, value) => ({ ok: true, value }),
    roots: async () => ({ ok: true, value: { items: [] } }), list: async () => page([complete('old')]),
    stat: async () => { throw new Error('A directory refresh must not stat individual files'); },
    open: async () => ({ ok: false, error: { kind: 'not_supported', message: 'Unused' } })
  };
  const registry: PluginRegistry = {
    async get(id) {
      const installation = store.installation(id);
      if (!installation || installation.status !== 'active') throw new Error('Missing fixture plugin');
      return { ...installation, module: source };
    },
    async isCurrent(id, revision, generation) {
      const installation = store.installation(id);
      return installation?.status === 'active' && installation.revision === revision && installation.generation === generation;
    }
  };
  const request = (async (_input: RequestInfo | URL) => new Response('fixture')) as typeof fetch;
  const sources = () => createSources(store, registry, request, () => now, { requests: 2 });
  const created = await sources().create(rawManifest.id, 'Fixture', { music: true }, signal());
  if (!created.ok) throw new Error('Cannot create fixture instance');
  const id = created.value.id; const stamp = await sources().view(id);
  const refreshes = () => createRefreshes(sources(), store, { pages: 100, entries: 1000 }, () => now);
  return { source, id, stamp, refreshes, get store() { return store; },
    snapshot: () => store.snapshot(id, key)?.value,
    reopen() { store.close(); store = openSqlite(path); },
    advance(milliseconds: number) { now += milliseconds; },
    async seed() {
      const job = await refreshes().start(id, { kind: 'directory', directoryRef });
      expect((await refreshes().step(job.operationId, signal())).status).toBe('completed');
      return store.snapshot(id, key)!.value!;
    }
  };
}

test('ordinary directory refresh publishes a fast complete listing and counts only explicitly deferred file properties', async () => {
  const f = await setup(); const calls: (string | undefined)[] = [];
  f.source.list = async (ctx, _directory, cursor) => {
    calls.push(ctx.fileInfo);
    return cursor === undefined ? page([deferred('one'), { ...file('ready'), deferredInfo: true,
      info: { contentId: 'ready-bytes', size: 42, mediaType: 'audio/flac' } }], 'last')
      : page([deferred('two'), file('legacy')]);
  };
  const job = await f.refreshes().start(f.id, { kind: 'directory', directoryRef });
  await f.refreshes().step(job.operationId, signal());
  expect(f.snapshot()).toBeNull();
  expect((await f.store.refreshRecord(job.operationId))?.task?.pendingFileInfo).toBe(1);
  expect((await f.refreshes().step(job.operationId, signal())).status).toBe('completed');
  expect(f.snapshot()).toMatchObject({ pendingFileInfo: 2 });
  expect(f.snapshot()?.items.map(item => 'entryId' in item ? item.entryId : '')).toEqual(['one', 'ready', 'two', 'legacy']);
  expect(f.store.snapshotHeader(f.id, key)).toMatchObject({ pendingFileInfo: 2 });
  expect(calls).toEqual([undefined, undefined]);
});

test('file-info reenumeration atomically publishes exact properties and retains source context, budgets and private-state saves', async () => {
  const f = await setup(); const old = await f.seed(); const calls: (string | undefined)[] = [];
  f.source.list = async (ctx, ref, cursor) => {
    calls.push(cursor); expect(ctx.fileInfo).toBe('required'); expect(ref).toBe(directoryRef);
    expect(ctx.instanceId).toBe(f.id); expect(ctx.config).toEqual({ music: true });
    expect(ctx.signal.aborted).toBe(false); expect(ctx.cache).toBeDefined();
    expect(ctx.workBudget?.remaining).toBe(2); await ctx.fetch('https://fixture.invalid/list');
    expect(ctx.workBudget?.remaining).toBe(1);
    if (cursor === undefined) return { ...page([{ ...file('one'), deferredInfo: true,
      info: { contentId: 'one-new-bytes', size: 123, mediaType: 'audio/flac' } }], 'last'), nextPrivateState: { token: 'saved' } };
    expect(ctx.privateState).toEqual({ token: 'saved' });
    return page([complete('two', 987)]);
  };
  const job = await f.refreshes().ensureFileInfo(f.stamp, directoryRef);
  expect(job.scope).toEqual({ kind: 'file-info', directoryRef });
  await f.refreshes().step(job.operationId, signal());
  expect(f.snapshot()).toEqual(old); f.reopen();
  expect((await f.refreshes().step(job.operationId, signal())).status).toBe('completed');
  expect(f.snapshot()?.items).toEqual([{ ...file('one'), deferredInfo: true,
    info: { contentId: 'one-new-bytes', size: 123, mediaType: 'audio/flac' } }, complete('two', 987)]);
  expect(f.snapshot()?.pendingFileInfo ?? 0).toBe(0); expect(f.snapshot()?.id).not.toBe(old.id);
  expect(calls).toEqual([undefined, 'last']);
});

for (const kind of ['temporary', 'rate_limited'] as const) {
  test(`file-info ${kind} retains the published directory and resumes the accepted cursor after storage reopens`, async () => {
    const f = await setup(); const old = await f.seed(); const calls: (string | undefined)[] = [];
    f.source.list = async (ctx, _directory, cursor) => {
      expect(ctx.fileInfo).toBe('required'); calls.push(cursor);
      if (cursor === undefined) return page([complete('first', 1000)], 'last');
      if (calls.length === 2) return { ok: false, error: { kind, message: 'Fixture interrupted', retryAfterSeconds: 2 } };
      return page([complete('last', 2000)]);
    };
    const job = await f.refreshes().ensureFileInfo(f.stamp, directoryRef);
    await f.refreshes().step(job.operationId, signal()); f.reopen();
    const waiting = await f.refreshes().step(job.operationId, signal());
    expect(waiting).toMatchObject({ status: 'running', current: { pages: 1, entries: 1 }, retryAt: new Date(3000).toISOString() });
    expect(f.snapshot()).toEqual(old); f.reopen();
    expect(await f.refreshes().ensureFileInfo(f.stamp, directoryRef)).toEqual(waiting);
    expect(await f.refreshes().step(job.operationId, signal())).toEqual(waiting);
    expect(calls).toEqual([undefined, 'last']); f.advance(2000);
    expect((await f.refreshes().step(job.operationId, signal())).status).toBe('completed');
    expect(f.snapshot()?.items).toEqual([complete('first', 1000), complete('last', 2000)]);
    expect(calls).toEqual([undefined, 'last', 'last']);
  });
}

test('file-info first-page failure or missing required properties preserves the old directory and stops without another preparation', async () => {
  for (const result of [
    { ok: false, error: { kind: 'unavailable', message: 'Fixture unavailable' } },
    page([deferred('missing')]), page([{ ...file('invalid'), info: { contentId: 'invalid', size: -1, mediaType: 'audio/flac' } }])
  ] satisfies Outcome<Page<Entry>>[]) {
    const f = await setup(); const old = await f.seed(); let calls = 0;
    f.source.list = async ctx => { expect(ctx.fileInfo).toBe('required'); calls++; return result; };
    const job = await f.refreshes().start(f.id, { kind: 'file-info', directoryRef });
    const failed = await f.refreshes().step(job.operationId, signal());
    expect(failed).toMatchObject({ status: 'failed', error: { code: result.ok ? 'invalid_source' : 'source_failed' } });
    expect(f.snapshot()).toEqual(old); f.reopen();
    expect(await f.refreshes().step(job.operationId, signal())).toEqual(failed); expect(calls).toBe(1);
  }
});

test('ordinary refresh rejects a non-true deferred marker even when file properties are complete', async () => {
  const f = await setup(); const old = await f.seed();
  f.source.list = async () => page([{ ...complete('invalid-marker'), deferredInfo: false } as unknown as Entry]);
  const job = await f.refreshes().start(f.id, { kind: 'directory', directoryRef });
  expect(await f.refreshes().step(job.operationId, signal())).toMatchObject({ status: 'failed', error: { code: 'invalid_source' } });
  expect(f.snapshot()).toEqual(old);
});

test('ordinary file-info requests reuse active refreshes and inherit a cancelled source cooldown', async () => {
  const f = await setup(); let calls = 0;
  f.source.list = async () => { calls++; return { ok: false, error: { kind: 'rate_limited', message: 'Wait', retryAfterSeconds: 5 } }; };
  const existing = await f.refreshes().ensure(f.stamp, key);
  expect((await f.refreshes().ensureFileInfo(f.stamp, directoryRef)).operationId).toBe(existing.operationId);
  const waiting = await f.refreshes().step(existing.operationId, signal());
  await f.refreshes().cancel(existing.operationId);
  const preparing = await f.refreshes().ensureFileInfo(f.stamp, directoryRef);
  expect(preparing.scope).toEqual({ kind: 'file-info', directoryRef });
  expect(preparing.retryAt).toBe(waiting.retryAt);
  expect((await f.refreshes().ensure(f.stamp, key)).operationId).toBe(preparing.operationId);
  expect(await f.refreshes().step(preparing.operationId, signal())).toEqual(preparing); expect(calls).toBe(1);
});

test('a late file-info page cannot overwrite the directory published by an explicit replacement', async () => {
  const f = await setup(); await f.seed();
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  f.source.list = async ctx => {
    if (ctx.fileInfo === 'required') { entered.resolve(); await release.promise; return page([complete('late')]); }
    return page([complete('replacement')]);
  };
  const preparing = await f.refreshes().ensureFileInfo(f.stamp, directoryRef);
  const late = f.refreshes().step(preparing.operationId, signal()); await entered.promise;
  const replacement = await f.refreshes().start(f.id, { kind: 'directory', directoryRef });
  expect((await f.refreshes().step(replacement.operationId, signal())).status).toBe('completed');
  release.resolve(); expect((await late).status).toBe('superseded');
  expect(f.snapshot()?.items).toEqual([complete('replacement')]);
});
