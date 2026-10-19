import { afterEach, expect, test } from 'bun:test';
import type { Entry, Outcome, Page, SourcePlugin } from '@musicfs/plugin-api';
import { createLibrary, PendingRefreshError } from '../src/core/library';
import { libraryFixture } from './helpers/library-fixture';

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
  expect(await fixture.rebuild().directoryStatus(fixture.id, directory)).toEqual({ completedAt: published.completedAt, statistics: published.statistics! });
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
