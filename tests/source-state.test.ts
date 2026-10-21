import { afterEach, expect, test } from 'bun:test';
import type { Json, Outcome, Page, Root, SourcePlugin } from '@musicfs/plugin-api';
import { createExtensions, parseManifest, type PluginRegistry } from '../src/core/extensions';
import { createSources } from '../src/core/sources';
import { createLibrary } from '../src/core/library';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import manifest from '../plugins/sample/manifest.json';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
const signal = () => new AbortController().signal;
const gate = <T>() => Promise.withResolvers<T>();

async function setup(roots: SourcePlugin['roots']) {
  const db = openSqlite(':memory:'); cleanups.push(db.close);
  const parsed = parseManifest(manifest, 'desktop');
  db.activate(parsed, 'a'.repeat(64), null);
  const unsupported = async () => ({ ok: false as const, error: { kind: 'not_supported' as const, message: 'Not used in this state test' } });
  const module: SourcePlugin = {
    configuration: { schema: { type: 'object' } },
    validateConfig: async (_ctx, config) => ({ ok: true, value: config }),
    roots, list: unsupported, stat: unsupported, open: unsupported
  };
  const registry: PluginRegistry = {
    async get(id) { const installed = db.installation(id); if (!installed) throw new Error('Missing test installation'); return { ...installed, module }; },
    async isCurrent(id, revision, generation) { const installed = db.installation(id); return installed?.status === 'active' && installed.revision === revision && installed.generation === generation; }
  };
  const sources = createSources(db, registry);
  const created = await sources.create(manifest.id, 'test', { label: 'before' }, signal());
  if (!created.ok) throw new Error('Fixture creation failed');
  return { db, sources, module, id: created.value.id, extensions: createExtensions(db, async () => {}) };
}

test('persists a confirmed renewed credential even when content fetching fails', async () => {
  const { db, sources, id } = await setup(async () => ({ ok: false,
    error: { kind: 'temporary', message: 'Directory request failed' }, nextPrivateState: { token: 'new-test-token' } }));
  expect((await sources.roots(id, signal())).ok).toBe(false);
  expect(db.capture(id)?.privateState).toEqual({ token: 'new-test-token' });
});

for (const mutation of ['configuration', 'deletion', 'removal'] as const) {
  test(`${mutation} fences the result of a previously started call`, async () => {
    const started = gate<void>();
    const pending = gate<Outcome<Page<Root>>>();
    const { db, sources, id, extensions } = await setup(async () => { started.resolve(); return pending.promise; });
    const call = sources.roots(id, signal());
    await started.promise;
    if (mutation === 'configuration') await sources.configure(id, { label: 'after' }, signal());
    if (mutation === 'deletion') await sources.delete(id);
    if (mutation === 'removal') await extensions.remove(manifest.id);
    pending.resolve({ ok: true, value: { items: [] }, nextPrivateState: { stale: true } });
    await expect(call).rejects.toMatchObject({ code: 'stale_call' });
    if (mutation === 'configuration') {
      expect(db.capture(id)?.config).toEqual({ label: 'after' });
      expect(db.capture(id)?.privateState).toBeNull();
    }
    if (mutation === 'deletion') expect(await sources.instances()).toHaveLength(0);
    if (mutation === 'removal') expect(await sources.instances()).toHaveLength(1);
  });
}

test('concurrent private-state updates use CAS instead of last-writer-wins', async () => {
  const firstStarted = gate<void>(); const secondStarted = gate<void>();
  const first = gate<Outcome<Page<Root>>>(); const second = gate<Outcome<Page<Root>>>();
  let calls = 0;
  const { db, sources, id } = await setup(async () => {
    if (++calls === 1) { firstStarted.resolve(); return first.promise; }
    secondStarted.resolve(); return second.promise;
  });
  const a = sources.roots(id, signal()); await firstStarted.promise;
  const b = sources.roots(id, signal()); await secondStarted.promise;
  second.resolve({ ok: true, value: { items: [] }, nextPrivateState: { order: 2 } }); await b;
  first.resolve({ ok: true, value: { items: [] }, nextPrivateState: { order: 1 } });
  await expect(a).rejects.toMatchObject({ code: 'stale_call' });
  expect(db.capture(id)?.privateState).toEqual({ order: 2 });
});

test('a configuration validator can deliberately clear private state with null', async () => {
  const { db, sources, id, module } = await setup(async () => ({ ok: true, value: { items: [] }, nextPrivateState: { token: 'test' } }));
  await sources.roots(id, signal());
  expect(db.capture(id)?.privateState).toEqual({ token: 'test' });
  module.validateConfig = async (_ctx, config) => ({ ok: true, value: config, nextPrivateState: null as Json });
  expect((await sources.configure(id, { label: 'after' }, signal())).ok).toBe(true);
  expect(db.capture(id)?.privateState).toBeNull();
});

test('equivalent normalized configuration and state preserve authentication, caches and a queued refresh', async () => {
  let rootCalls = 0;
  const { db, sources, id, module } = await setup(async ctx => {
    rootCalls++;
    expect(ctx.privateState).toEqual({ session: { token: 'fixture-token', expires: 123 } });
    if (rootCalls === 1) await ctx.cache!.put('prepared', { content: 'fixture' });
    else expect(await ctx.cache!.get('prepared')).toEqual({ content: 'fixture' });
    return { ok: true, value: { items: [] } };
  });
  module.validateConfig = async () => ({ ok: true, value: { label: 'before', options: { cover: true, lyric: true } } });
  await sources.configure(id, { label: ' BEFORE ' }, signal());
  module.authenticate = async () => ({ ok: true, value: { kind: 'complete', accountName: 'Fixture' },
    nextPrivateState: { session: { token: 'fixture-token', expires: 123 } } });
  expect((await sources.authenticate(id, { kind: 'start' }, signal())).ok).toBe(true);
  await sources.roots(id, signal());
  const library = createLibrary(sources, db);
  const refresh = await library.refreshes.start(id, { kind: 'directory' });
  const before = db.capture(id)!; const configure = db.configure; let writes = 0;
  db.configure = (...args) => { writes++; return configure(...args); };
  module.validateConfig = async () => ({ ok: true, value: { options: { lyric: true, cover: true }, label: 'before' },
    nextPrivateState: { session: { expires: 123, token: 'fixture-token' } } });
  expect((await sources.configure(id, { label: 'before', options: { lyric: true, cover: true } }, signal())).ok).toBe(true);
  expect(writes).toBe(0); expect(db.capture(id)).toEqual(before);
  expect(await sources.authentication(id)).toMatchObject({ step: { kind: 'complete', accountName: 'Fixture' } });
  expect((await library.refreshes.step(refresh.operationId, signal())).status).toBe('completed');
  expect(rootCalls).toBe(2);
});

test('unchanged configuration with changed private state still commits and invalidates the source', async () => {
  const { db, sources, id, module } = await setup(async () => ({ ok: true, value: { items: [] } }));
  const before = db.capture(id)!;
  module.validateConfig = async (_ctx, config) => ({ ok: true, value: config, nextPrivateState: { token: 'updated-test-token' } });
  expect((await sources.configure(id, { label: 'before' }, signal())).ok).toBe(true);
  expect(db.capture(id)).toMatchObject({ epoch: before.epoch + 1, stateRevision: before.stateRevision + 1,
    config: before.config, privateState: { token: 'updated-test-token' } });
});

test('no-op save does not overwrite a credential renewed concurrently during validation', async () => {
  const started = gate<void>(); const pending = gate<Outcome<Json>>(); let token = 'original';
  const { db, sources, id, module } = await setup(async () => ({ ok: true, value: { items: [] }, nextPrivateState: { token } }));
  await sources.roots(id, signal()); const before = db.capture(id)!;
  module.validateConfig = async () => { started.resolve(); return pending.promise; };
  const save = sources.configure(id, { label: 'before' }, signal()); await started.promise;
  token = 'renewed'; await sources.roots(id, signal());
  pending.resolve({ ok: true, value: { label: 'before' } });
  expect((await save).ok).toBe(true);
  expect(db.capture(id)).toMatchObject({ epoch: before.epoch, stateRevision: before.stateRevision + 1, privateState: { token: 'renewed' } });
});

test('an aborted call cannot publish state even if a plugin ignores cancellation', async () => {
  const started = gate<void>(); const pending = gate<Outcome<Page<Root>>>();
  const { db, sources, id } = await setup(async () => { started.resolve(); return pending.promise; });
  const abort = new AbortController();
  const call = sources.roots(id, abort.signal); await started.promise;
  abort.abort(new Error('Cancelled fixture operation'));
  pending.resolve({ ok: true, value: { items: [] }, nextPrivateState: { stale: true } });
  await expect(call).rejects.toThrow('Cancelled fixture operation');
  expect(db.capture(id)?.privateState).toBeNull();
});

test('a stream obtained by an obsolete call is cancelled before it can escape', async () => {
  const started = gate<void>();
  const pending = gate<void>();
  const { sources, id, module } = await setup(async () => ({ ok: true, value: { items: [] } }));
  let cancelled = false;
  module.open = async () => {
    started.resolve(); await pending.promise;
    return { ok: true, value: { content: { contentId: 'fixture', size: 4, mediaType: 'audio/wav' }, servedRange: null,
      body: new ReadableStream({ cancel() { cancelled = true; } }) } };
  };
  const call = sources.open(id, 'file', { expectedContentId: 'fixture' }, signal()); await started.promise;
  await sources.configure(id, { label: 'after' }, signal()); pending.resolve();
  await expect(call).rejects.toMatchObject({ code: 'stale_call' });
  expect(cancelled).toBe(true);
});
