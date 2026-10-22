import { afterEach, expect, test } from 'bun:test';
import type { Entry, Outcome, Page, SourcePlugin } from '@musicfs/plugin-api';
import { createLibrary, PendingRefreshError } from '../src/core/library';
import { libraryFixture } from './helpers/library-fixture';
import { createRefreshes } from '../src/core/library/refresh';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const signal = () => new AbortController().signal;
const directory = 'music';
const path = '/实例 & #/来源';
const key = { kind: 'directory' as const, ref: directory };
const entry = (id: string): Entry => ({ kind: 'file', entryId: id, name: `${id}.wav`, fileRef: id });
const page = (items: Entry[]): Outcome<Page<Entry>> => ({ ok: true, value: { items } });
function plugin(overrides: Partial<SourcePlugin> = {}): SourcePlugin {
  return {
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, candidate) => ({ ok: true, value: candidate }),
    roots: async () => ({ ok: true, value: { items: [{ sourceId: 'root', name: '来源', directoryRef: directory }] } }),
    list: async () => page([entry('old')]),
    stat: async () => ({ ok: false, error: { kind: 'not_supported', message: 'Unused by refresh tests' } }),
    open: async () => ({ ok: false, error: { kind: 'not_supported', message: 'Unused by refresh tests' } }),
    ...overrides
  };
}
async function setup(source = plugin()) {
  const fixture = await libraryFixture(source); cleanups.push(fixture.close);
  const rebuild = () => createLibrary(fixture.sources, fixture.store, undefined, { execution: 'deferred' });
  return { ...fixture, source, rebuild };
}
async function pending(work: Promise<unknown>): Promise<PendingRefreshError> {
  try { await work; } catch (error) {
    if (error instanceof PendingRefreshError) return error;
    throw error;
  }
  throw new Error('A cold deferred directory must return a pending operation');
}

test('a long refresh gives a waiting instance a turn after each committed page', async () => {
  const f = await setup(plugin({ list: async (_ctx, _ref, cursor) => cursor ? page([entry('last')])
    : { ok: true, value: { items: [entry('first')], nextCursor: 'last' } } }));
  const other = await f.sources.create(f.store.installations()[0]!.manifest.id, 'Other', {}, signal());
  if (!other.ok) throw new Error('Fixture instance creation failed');
  let now = 1000;
  const refresh = createRefreshes(f.sources, f.store, { pages: 100, entries: 1000 }, () => now);
  const first = await refresh.start(f.id, { kind: 'directory', directoryRef: directory });
  now++;
  const second = await refresh.start(other.value.id, { kind: 'directory', directoryRef: directory });
  now++;
  expect(await refresh.stepNext(signal())).toMatchObject({ operationId: first.operationId, status: 'running' });
  now++;
  expect(await refresh.stepNext(signal())).toMatchObject({ operationId: second.operationId, status: 'running' });
});

test('desktop publication compares staged pages and final entries before invalidating mounted listings', async () => {
  const f = await setup(plugin({ list: async () => page([entry('first'), entry('last')]) }));
  await f.library.refresh(f.id, directory, signal());
  f.source.list = async () => ({ ok: true, value: { items: [entry('first')], nextCursor: 'last' } });
  const refresh = f.rebuild().refreshes;
  const job = await refresh.start(f.id, { kind: 'directory', directoryRef: directory });
  await refresh.step(job.operationId, signal());
  const record = f.store.refreshRecord(job.operationId)!;
  const publish = { stamp: record.stamp, id: record.task!.attemptId, kind: 'directory' as const, completedAt: job.createdAt };
  expect(f.store.publishedEntriesChanged(record, { items: [entry('last')], publish })).toBe(false);
  expect(f.store.publishedEntriesChanged(record, { items: [{ ...entry('last'), name: 'Renamed.wav' }], publish })).toBe(true);
  expect(f.store.publishedEntriesChanged(record, { items: [], publish })).toBe(true);
  expect(f.store.publishedEntriesChanged({ ...record, stamp: { ...record.stamp, epoch: record.stamp.epoch + 1 } }, { items: [entry('last')], publish })).toBe(true);
});

test('metadata refresh keeps one explicit intent across durable pages and publishes only after completion', async () => {
  const observed: string[] = [];
  const f = await setup(plugin({ metadataRefresh: true, list: async (ctx, _directory, cursor) => {
    if (!ctx.metadataRefresh) return page([entry('old')]);
    expect(ctx.fileInfo).toBe('required'); observed.push(ctx.metadataRefresh);
    const item = { ...entry(cursor ? 'last' : 'first'), info: { contentId: 'new', size: 1, mediaType: 'audio/wav' } };
    return { ok: true, value: { items: [item], ...(cursor ? {} : { nextCursor: 'next' }) } };
  } }));
  await f.library.refresh(f.id, directory, signal());
  const job = await f.rebuild().refreshes.start(f.id, { kind: 'metadata', directoryRef: directory });
  expect(await f.rebuild().refreshes.step(job.operationId, signal())).toMatchObject({ status: 'running' });
  expect(f.store.snapshot(f.id, key)?.value?.items[0]).toMatchObject({ fileRef: 'old' });
  expect(await f.rebuild().refreshes.step(job.operationId, signal())).toMatchObject({ status: 'completed' });
  expect(observed).toEqual([job.operationId, job.operationId]);
  expect(f.store.snapshot(f.id, key)?.value?.items).toHaveLength(2);
});

test('rate limits persist a cooldown and resume the same directory cursor without repeating accepted pages', async () => {
  const f = await setup(); let now = 1000; let calls = 0;
  f.source.list = async (_ctx, _ref, cursor) => {
    calls++;
    if (!cursor) return { ok: true, value: { items: [entry('first')], nextCursor: 'second', progress: { completed: 1, total: 2, unit: 'items' } } };
    if (calls === 2) return { ok: false, error: { kind: 'rate_limited', message: 'Wait', retryAfterSeconds: 7 } };
    expect(cursor).toBe('second');
    return { ok: true, value: { items: [entry('last')], progress: { completed: 2, total: 2, unit: 'items' } } };
  };
  const rebuild = () => createRefreshes(f.sources, f.store, { pages: 100, entries: 1000 }, () => now);
  const refresh = rebuild(); const job = await refresh.start(f.id, { kind: 'directory', directoryRef: directory });
  expect(await refresh.step(job.operationId, signal())).toMatchObject({ status: 'running', current: { pages: 1, progress: { completed: 1, total: 2 } } });
  const waiting = await refresh.step(job.operationId, signal());
  expect(waiting).toMatchObject({ status: 'running', retryAt: new Date(8000).toISOString(), current: { pages: 1, entries: 1 } });
  expect(await f.store.readyRefreshes(now, 1)).toEqual([]);
  expect(f.store.nextBackgroundWorkAt()).toBe(8000);
  expect(await f.store.claimRefresh(job.operationId, 'early', now, now + 100)).toBeNull();
  expect(await rebuild().step(job.operationId, signal())).toEqual(waiting); expect(calls).toBe(2);
  now = 8000;
  const finished = await rebuild().step(job.operationId, signal());
  expect(finished).toMatchObject({ status: 'completed', current: { pages: 2, progress: { completed: 2, total: 2 } } });
  expect(finished.retryAt).toBeUndefined(); expect(finished.error).toBeUndefined(); expect(calls).toBe(3);
  expect(f.store.snapshot(f.id, key)?.value?.items.map(item => 'entryId' in item ? item.entryId : '')).toEqual(['first', 'last']);
});

test('restarting or cancelling a refresh does not bypass a known source cooldown', async () => {
  let calls = 0;
  const f = await setup(plugin({ list: async () => { calls++; return { ok: false, error: { kind: 'rate_limited', message: 'Wait', retryAfterSeconds: 9 } }; } }));
  const refresh = createRefreshes(f.sources, f.store, { pages: 100, entries: 1000 }, () => 1000);
  const first = await refresh.start(f.id, { kind: 'directory', directoryRef: directory });
  const waiting = await refresh.step(first.operationId, signal()); await refresh.cancel(first.operationId);
  const next = await refresh.start(f.id, { kind: 'directory', directoryRef: directory });
  expect(next.retryAt).toBe(waiting.retryAt); expect(next.operationId).not.toBe(first.operationId);
  expect((await refresh.step(next.operationId, signal())).status).toBe('queued'); expect(calls).toBe(1);
});

test('exhausting rate-limit retries stops the instance instead of requesting another directory', async () => {
  let now = 1000; const visited: string[] = [];
  const f = await setup(plugin({
    roots: async () => ({ ok: true, value: { items: ['a', 'b'].map(ref => ({ sourceId: ref, name: ref, directoryRef: ref })) } }),
    list: async (_ctx, ref) => { visited.push(ref); return { ok: false, error: { kind: 'rate_limited', message: 'Wait', retryAfterSeconds: 1 } }; }
  }));
  const refresh = createRefreshes(f.sources, f.store, { pages: 100, entries: 1000 }, () => now);
  let job = await refresh.start(f.id, { kind: 'instance' }); job = await refresh.step(job.operationId, signal());
  for (let i = 0; i < 6; i++) { job = await refresh.step(job.operationId, signal()); now += 1000; }
  expect(job.status).toBe('failed'); expect(visited).toEqual(Array(6).fill('a'));
});

test('a temporary second-page failure keeps its cursor and resumes across controllers without repeating the first page', async () => {
  const f = await setup(); let now = 1000;
  const previous = await f.library.refresh(f.id, directory, signal());
  const calls: (string | undefined)[] = [];
  f.source.list = async (_ctx, _ref, cursor) => {
    calls.push(cursor);
    if (cursor === undefined) return { ok: true, value: { items: [entry('first')], nextCursor: 'second' } };
    if (calls.length === 2) return { ok: false, error: { kind: 'temporary', message: 'Fixture connection interrupted' } };
    return page([entry('last')]);
  };
  const rebuild = () => createRefreshes(f.sources, f.store, { pages: 100, entries: 1000 }, () => now);
  const refresh = rebuild(); const job = await refresh.start(f.id, { kind: 'directory', directoryRef: directory });
  await refresh.step(job.operationId, signal());
  const candidate = (await f.store.refreshRecord(job.operationId))!.task;
  const waiting = await refresh.step(job.operationId, signal());
  expect(waiting).toMatchObject({ status: 'running', retryAt: new Date(3000).toISOString(),
    current: { pages: 1, entries: 1 }, error: { sourceFault: { kind: 'temporary' } } });
  expect((await f.store.refreshRecord(job.operationId))!.task).toEqual(candidate);
  expect(f.store.snapshot(f.id, key)?.value).toEqual(previous);
  expect(await f.store.readyRefreshes(now, 1)).toEqual([]); expect(f.store.nextBackgroundWorkAt()).toBe(3000);
  expect(await rebuild().step(job.operationId, signal())).toEqual(waiting); expect(calls).toEqual([undefined, 'second']);
  now = 3000;
  const completed = await rebuild().step(job.operationId, signal());
  expect(completed).toMatchObject({ status: 'completed', current: { pages: 2, entries: 2 } });
  expect(completed.retryAt).toBeUndefined(); expect(completed.error).toBeUndefined();
  expect(calls).toEqual([undefined, 'second', 'second']);
  expect(f.store.snapshot(f.id, key)?.value?.items).toEqual([entry('first'), entry('last')]);
});

test('temporary retries stop after two waits and only then let an instance continue to its next directory', async () => {
  let now = 1000; const visited: string[] = [];
  const f = await setup(plugin({
    roots: async () => ({ ok: true, value: { items: ['a', 'b'].map(ref => ({ sourceId: ref, name: ref, directoryRef: ref })) } }),
    list: async (_ctx, ref) => {
      visited.push(ref);
      return ref === 'a' ? { ok: false, error: { kind: 'temporary', message: 'Fixture still offline' } } : page([entry('available')]);
    }
  }));
  const rebuild = () => createRefreshes(f.sources, f.store, { pages: 100, entries: 1000 }, () => now);
  const job = await rebuild().start(f.id, { kind: 'instance' });
  await rebuild().step(job.operationId, signal());
  const first = await rebuild().step(job.operationId, signal());
  expect(first).toMatchObject({ current: { directoryRef: 'a' }, failures: [], retryAt: new Date(3000).toISOString() });
  now = 3000;
  const second = await rebuild().step(job.operationId, signal());
  expect(second).toMatchObject({ current: { directoryRef: 'a' }, failures: [], retryAt: new Date(11_000).toISOString() });
  now = 11_000;
  const next = await rebuild().step(job.operationId, signal());
  expect(next).toMatchObject({ status: 'running', current: { directoryRef: 'b' },
    failures: [{ directoryRef: 'a', error: { sourceFault: { kind: 'temporary' } } }] });
  expect(next.retryAt).toBeUndefined(); expect(next.error).toBeUndefined(); expect(visited).toEqual(['a', 'a', 'a']);
  expect((await rebuild().step(job.operationId, signal())).status).toBe('completed');
  expect(visited).toEqual(['a', 'a', 'a', 'b']);
  expect(f.store.snapshot(f.id, { kind: 'directory', ref: 'a' })?.error).toBe('temporary');
});

test('temporary and rate-limit counters remain independent, and a successful page resets both', async () => {
  let now = 1000; let calls = 0;
  const f = await setup(plugin({ list: async (_ctx, _ref, cursor) => {
    calls++;
    if (calls === 1 || calls === 3 || calls === 5) return { ok: false, error: { kind: 'temporary', message: 'Fixture transient failure' } };
    if (calls === 2) return { ok: false, error: { kind: 'rate_limited', message: 'Fixture limited', retryAfterSeconds: 7 } };
    return cursor === undefined ? { ok: true, value: { items: [entry('first')], nextCursor: 'second' } } : page([entry('last')]);
  } }));
  const refresh = createRefreshes(f.sources, f.store, { pages: 100, entries: 1000 }, () => now);
  const job = await refresh.start(f.id, { kind: 'directory', directoryRef: directory });
  expect((await refresh.step(job.operationId, signal())).retryAt).toBe(new Date(3000).toISOString());
  now = 3000;
  expect((await refresh.step(job.operationId, signal())).retryAt).toBe(new Date(10_000).toISOString());
  expect(await f.store.refreshRecord(job.operationId)).toMatchObject({ temporaryRetries: 1, rateLimitRetries: 1 });
  now = 10_000;
  expect((await refresh.step(job.operationId, signal())).retryAt).toBe(new Date(18_000).toISOString());
  now = 18_000;
  expect(await refresh.step(job.operationId, signal())).toMatchObject({ status: 'running', current: { pages: 1 } });
  const accepted = (await f.store.refreshRecord(job.operationId))!;
  expect(accepted.temporaryRetries).toBeUndefined(); expect(accepted.rateLimitRetries).toBeUndefined();
  // The next page gets its own first short retry rather than inheriting the previous page's count.
  expect((await refresh.step(job.operationId, signal())).retryAt).toBe(new Date(20_000).toISOString());
  now = 20_000;
  expect((await refresh.step(job.operationId, signal())).status).toBe('completed'); expect(calls).toBe(6);
});

test('cancelling a temporary wait stops future source calls', async () => {
  let now = 1000; let calls = 0;
  const f = await setup(plugin({ list: async () => { calls++; return { ok: false, error: { kind: 'temporary', message: 'Fixture offline' } }; } }));
  const refresh = createRefreshes(f.sources, f.store, { pages: 100, entries: 1000 }, () => now);
  const job = await refresh.start(f.id, { kind: 'directory', directoryRef: directory });
  expect((await refresh.step(job.operationId, signal())).status).toBe('running');
  await refresh.cancel(job.operationId); now = 20_000;
  expect((await refresh.step(job.operationId, signal())).status).toBe('cancelled'); expect(calls).toBe(1);
});

test('authentication, invalid configuration and changed content failures do not enter temporary retries', async () => {
  for (const kind of ['needs_auth', 'invalid_config', 'content_changed'] as const) {
    const f = await setup(plugin({ list: async () => ({ ok: false, error: { kind, message: 'Fixture needs explicit correction' } }) }));
    const refresh = createRefreshes(f.sources, f.store, { pages: 100, entries: 1000 }, () => 1000);
    const job = await refresh.start(f.id, { kind: 'directory', directoryRef: directory });
    const failed = await refresh.step(job.operationId, signal());
    expect(failed).toMatchObject({ status: 'failed', error: { sourceFault: { kind } } });
    expect(failed.retryAt).toBeUndefined();
  }
});

test('42 pages resume across Library controllers, publish once, and preserve ordered entries and additive statistics', async () => {
  const fixture = await setup();
  await fixture.library.contentSources(fixture.id, signal());
  const previous = await fixture.library.refresh(fixture.id, directory, signal());
  const calls: (string | undefined)[] = [];
  const pages = Array.from({ length: 42 }, (_, index) => ({
    items: Array.from({ length: index === 41 ? 27 : 46 }, (_, offset) => entry(`entry-${String(index * 46 + offset).padStart(4, '0')}`)),
    statistics: { records: index === 41 ? 58 : 100, exported: index === 41 ? 27 : 46, unavailable: index === 41 ? 31 : 54 }
  }));
  fixture.source.list = async (_ctx, ref, cursor) => {
    expect(ref).toBe(directory); calls.push(cursor);
    const index = cursor === undefined ? 0 : Number(cursor.slice('page-'.length));
    return { ok: true, value: { ...pages[index]!, ...(index < 41 ? { nextCursor: `page-${index + 1}` } : {}) } };
  };
  let library = fixture.rebuild();
  let progress = await library.refreshes.start(fixture.id, { kind: 'directory', directoryRef: directory });
  expect(progress.status).toBe('queued'); expect(calls).toEqual([]);
  for (let index = 0; index < 42; index++) {
    library = fixture.rebuild();
    expect(await library.refreshes.get(progress.operationId)).toEqual(progress);
    expect(await library.refreshes.current(fixture.id)).toEqual(progress);
    const before = calls.length;
    progress = await library.refreshes.step(progress.operationId, signal());
    expect(calls.length - before).toBe(1);
    expect(calls[index]).toBe(index === 0 ? undefined : `page-${index}`);
    expect(progress.current).toMatchObject({ kind: 'directory', directoryRef: directory, pages: index + 1,
      entries: index === 41 ? 1913 : (index + 1) * 46 });
    if (index < 41) {
      expect(progress.status).toBe('running');
      expect(fixture.store.snapshot(fixture.id, key)?.value).toEqual(previous);
      expect((await library.files.list(path, signal())).map(item => item.name)).toEqual(['old.wav']);
      expect(calls.length).toBe(before + 1);
    }
  }
  expect(progress).toMatchObject({ status: 'completed', refreshedDirectories: 1, failures: [],
    current: { statistics: { records: 4158, exported: 1913, unavailable: 2245 } } });
  const published = fixture.store.snapshot(fixture.id, key)!.value!;
  expect(published.id).not.toBe(previous.id);
  expect(published.items).toEqual(pages.flatMap(item => item.items));
  expect(published.statistics).toEqual({ records: 4158, exported: 1913, unavailable: 2245 });
  expect(await fixture.rebuild().directoryStatus(fixture.id, directory)).toEqual({ completedAt: published.completedAt, statistics: published.statistics!, error: null });
  expect((await fixture.rebuild().files.list(path, signal())).map(item => item.name)).toEqual(pages.flatMap(item => item.items.map(value => value.name)));
  expect(await fixture.rebuild().refreshes.step(progress.operationId, signal())).toEqual(progress);
  expect(calls).toHaveLength(42);
});

for (const action of ['cancel', 'replace'] as const) {
  test(`a page arriving after ${action} cannot publish or overwrite the persisted operation`, async () => {
    const fixture = await setup();
    const previous = await fixture.library.refresh(fixture.id, directory, signal());
    const arrived = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); let calls = 0;
    fixture.source.list = async () => {
      if (++calls === 1) { arrived.resolve(); await release.promise; return page([entry('late')]); }
      return page([entry('replacement')]);
    };
    const operation = await fixture.rebuild().refreshes.start(fixture.id, { kind: 'directory', directoryRef: directory });
    const work = fixture.rebuild().refreshes.step(operation.operationId, signal());
    await arrived.promise;
    let replacementId: string | undefined;
    if (action === 'cancel') {
      expect(await fixture.rebuild().refreshes.cancel(operation.operationId)).toMatchObject({ status: 'cancelled' });
    } else {
      const replacement = await fixture.rebuild().refreshes.start(fixture.id, { kind: 'directory', directoryRef: directory });
      replacementId = replacement.operationId;
      expect(replacementId).not.toBe(operation.operationId);
      expect(await fixture.rebuild().refreshes.step(replacementId, signal())).toMatchObject({ status: 'completed' });
    }
    release.resolve(); await work;
    expect(await fixture.rebuild().refreshes.get(operation.operationId)).toMatchObject({ status: action === 'cancel' ? 'cancelled' : 'superseded' });
    const snapshot = fixture.store.snapshot(fixture.id, key)!;
    expect(snapshot.error).toBeNull();
    if (action === 'cancel') {
      expect(snapshot.value).toEqual(previous);
      expect(await fixture.rebuild().refreshes.current(fixture.id)).toMatchObject({ operationId: operation.operationId, status: 'cancelled' });
    } else {
      expect(snapshot.value?.items).toEqual([entry('replacement')]);
      expect(await fixture.rebuild().refreshes.current(fixture.id)).toMatchObject({ operationId: replacementId!, status: 'completed' });
    }
    expect(calls).toBe(action === 'cancel' ? 1 : 2);
  });
}

test('deferred cache misses reuse their pending operation and expose no partial directory', async () => {
  let roots = 0; const calls: (string | undefined)[] = [];
  const source = plugin({ roots: async () => { roots++; return { ok: true, value: { items: [{ sourceId: 'root', name: '来源', directoryRef: directory }] } }; },
    list: async (_ctx, _ref, cursor) => { calls.push(cursor); return { ok: true, value: cursor === undefined
      ? { items: [entry('one')], nextCursor: 'last' } : { items: [entry('two')] } }; } });
  const fixture = await setup(source);
  const [firstRoot, repeatedRoot] = await Promise.all([
    pending(fixture.rebuild().contentSources(fixture.id, signal())), pending(fixture.rebuild().contentSources(fixture.id, signal()))
  ]);
  expect(firstRoot.code).toBe('refresh_pending'); expect(repeatedRoot.operationId).toBe(firstRoot.operationId);
  expect(await fixture.rebuild().refreshes.current(fixture.id)).toMatchObject({ operationId: firstRoot.operationId, status: 'queued' });
  expect(roots).toBe(0); expect(calls).toEqual([]);
  await fixture.rebuild().refreshes.step(firstRoot.operationId, signal());
  expect(await fixture.rebuild().contentSources(fixture.id, signal())).toEqual([{ sourceId: 'root', name: '来源', directoryRef: directory }]);
  const firstDirectory = await pending(fixture.rebuild().files.list(path, signal()));
  const repeatedDirectory = await pending(fixture.rebuild().files.list(path, signal()));
  expect(repeatedDirectory.operationId).toBe(firstDirectory.operationId);
  expect(firstDirectory.operationId).not.toBe(firstRoot.operationId); expect(calls).toEqual([]);
  expect(await fixture.rebuild().refreshes.step(firstDirectory.operationId, signal())).toMatchObject({ status: 'running', current: { pages: 1, entries: 1 } });
  const partial = await pending(fixture.rebuild().files.list(path, signal()));
  expect(partial.operationId).toBe(firstDirectory.operationId);
  expect(fixture.store.snapshot(fixture.id, key)?.value).toBeNull(); expect(calls).toEqual([undefined]);
  expect(await fixture.rebuild().refreshes.step(partial.operationId, signal())).toMatchObject({ status: 'completed' });
  expect((await fixture.rebuild().files.list(path, signal())).map(item => item.name)).toEqual(['one.wav', 'two.wav']);
  expect(roots).toBe(1); expect(calls).toEqual([undefined, 'last']);
});

test('an aborted step releases its lease without cancelling the persistent operation', async () => {
  const fixture = await setup();
  const arrived = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); let calls = 0;
  fixture.source.list = async () => {
    if (++calls === 1) { arrived.resolve(); await release.promise; }
    return page([entry('complete')]);
  };
  const operation = await fixture.rebuild().refreshes.start(fixture.id, { kind: 'directory', directoryRef: directory });
  const controller = new AbortController(); const reason = new Error('Fixture connection closed');
  const work = fixture.rebuild().refreshes.step(operation.operationId, controller.signal).then(() => null, (error: unknown) => error);
  await arrived.promise; controller.abort(reason); release.resolve();
  expect(await work).toBe(reason);
  expect(await fixture.rebuild().refreshes.get(operation.operationId)).toMatchObject({ status: 'running', current: { pages: 0, entries: 0 } });
  expect(fixture.store.snapshot(fixture.id, key)?.value).toBeNull();
  expect(await fixture.rebuild().refreshes.step(operation.operationId, signal())).toMatchObject({ status: 'completed' });
  expect(fixture.store.snapshot(fixture.id, key)?.value?.items).toEqual([entry('complete')]); expect(calls).toBe(2);
});
