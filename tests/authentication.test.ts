import { afterEach, expect, test } from 'bun:test';
import type { AuthStep, Outcome, SourcePlugin } from '@musicfs/plugin-api';
import { createSources } from '../src/core/sources';
import { parseManifest, type PluginRegistry } from '../src/core/extensions';
import { createLibrary } from '../src/core/library';
import { createManagementApi } from '../src/transport/http';
import { createExtensions } from '../src/core/extensions';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import manifest from '../plugins/sample/manifest.json';

const cleanups: (() => void)[] = []; afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
const signal = () => new AbortController().signal;
const now = Date.parse('2026-10-20T00:00:00Z');
const waiting = (challengeId = 'fixture-challenge'): AuthStep => ({ kind: 'waiting', challengeId, expiresAt: new Date(now + 60_000).toISOString(), message: 'Scan the fixture QR', qrCode: 'fixture-qr' });
const gate = <T>() => Promise.withResolvers<T>();

async function setup(authenticate?: SourcePlugin['authenticate']) {
  const store = openSqlite(':memory:'); cleanups.push(store.close);
  const parsed = parseManifest(manifest, 'desktop'); store.activate(parsed, 'a'.repeat(64), null);
  let time = now;
  const unsupported = async () => ({ ok: false as const, error: { kind: 'not_supported' as const, message: 'Unused fixture operation' } });
  const plugin: SourcePlugin = { configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, config) => ({ ok: true, value: config }),
    roots: async () => ({ ok: true, value: { items: [] } }), list: unsupported, stat: unsupported, open: unsupported, ...(authenticate ? { authenticate } : {}) };
  const registry: PluginRegistry = {
    get: async id => { const installation = store.installation(id); if (!installation) throw new Error('Missing fixture plugin'); return { ...installation, module: plugin }; },
    isCurrent: async (id, revision, generation) => { const installed = store.installation(id); return installed?.status === 'active' && installed.revision === revision && installed.generation === generation; }
  };
  const sources = createSources(store, registry, fetch, () => time);
  const created = await sources.create(manifest.id, '认证实例', {}, signal()); if (!created.ok) throw new Error('Fixture creation failed');
  const id = created.value.id;
  async function start() {
    const result = await sources.authenticate(id, { kind: 'start' }, signal()); if (!result.ok) throw new Error('Fixture start failed'); return result.value;
  }
  return { id, store, sources, plugin, start, registry, setTime(value: number) { time = value; } };
}

test('no-auth plugins do not start an operation or change their epoch', async () => {
  const { id, store, sources } = await setup();
  expect(await sources.authentication(id)).toBeNull();
  expect(await sources.authenticate(id, { kind: 'start' }, signal())).toMatchObject({ ok: false, error: { kind: 'not_supported' } });
  expect(store.capture(id)?.epoch).toBe(1);
});

test('a challenge resumes from persisted state in another coordinator and completes without exposing credentials', async () => {
  const fixture = await setup(async (_ctx, action) => action.kind === 'start'
    ? { ok: true, value: waiting(), nextPrivateState: { pendingSecret: 'fixture-private' } }
    : { ok: true, value: { kind: 'complete', accountName: 'Fixture account' }, nextPrivateState: { token: 'fixture-token' } });
  const { id, store, sources, start, registry } = fixture;
  const started = await start(); expect(started.step).toEqual(waiting()); expect(store.capture(id)?.epoch).toBe(2);
  const other = createSources(store, registry, fetch, () => now);
  expect(await other.authentication(id)).toEqual(started);
  const completed = await other.authenticate(id, { kind: 'poll', operationId: started.operationId, challengeId: 'fixture-challenge' }, signal());
  expect(completed).toMatchObject({ ok: true, value: { operationId: started.operationId, step: { kind: 'complete', accountName: 'Fixture account' } } });
  expect(store.capture(id)?.privateState).toEqual({ token: 'fixture-token' }); expect(store.capture(id)?.epoch).toBe(3);
  expect(JSON.stringify(await sources.authentication(id))).not.toContain('token');
});

test('input challenges accept only the current action and instance, and preserve confirmed state on a failed submission', async () => {
  const { id, store, sources, start } = await setup(async (_ctx, action) => action.kind === 'start'
    ? { ok: true, value: { kind: 'input', challengeId: 'input', expiresAt: new Date(now + 60_000).toISOString(), message: 'Enter fixture code', configuration: { schema: { type: 'object' } } } }
    : { ok: false, error: { kind: 'invalid_config', message: 'Wrong code', fields: [{ path: '/code', message: 'Try again' }] }, nextPrivateState: { verifiedNonce: 'fixture' } });
  const auth = await start();
  await expect(sources.authenticate(id, { kind: 'poll', operationId: auth.operationId, challengeId: 'input' }, signal())).rejects.toMatchObject({ code: 'invalid_auth_action' });
  await expect(sources.authenticate(id, { kind: 'submit', operationId: auth.operationId, challengeId: 'old', input: {} }, signal())).rejects.toMatchObject({ code: 'invalid_auth_action' });
  const second = await sources.create(manifest.id, '另一个实例', {}, signal()); if (!second.ok) throw new Error('Fixture creation failed');
  await expect(sources.authenticate(second.value.id, { kind: 'submit', operationId: auth.operationId, challengeId: 'input', input: {} }, signal())).rejects.toMatchObject({ code: 'invalid_auth_action' });
  expect((await sources.authenticate(id, { kind: 'submit', operationId: auth.operationId, challengeId: 'input', input: { code: 'wrong' } }, signal())).ok).toBe(false);
  expect(store.capture(id)?.privateState).toEqual({ verifiedNonce: 'fixture' });
  expect(await sources.authentication(id)).toMatchObject({ error: { kind: 'invalid_config' }, step: { kind: 'input' } });
});

for (const mutation of ['cancel', 'restart', 'configuration', 'removal', 'update', 'deletion'] as const) {
  test(`${mutation} prevents a late successful poll from replacing the current state`, async () => {
    const entered = gate<void>(); const pending = gate<Outcome<AuthStep>>();
    const { id, sources, store, start } = await setup(async (_ctx, action) => {
      if (action.kind === 'start') return { ok: true, value: waiting() };
      if (action.kind === 'cancel') return { ok: true, value: { kind: 'cancelled' } };
      entered.resolve(); return pending.promise;
    });
    const auth = await start(); const poll = sources.authenticate(id, { kind: 'poll', operationId: auth.operationId, challengeId: 'fixture-challenge' }, signal()); await entered.promise;
    if (mutation === 'cancel') await sources.authenticate(id, { kind: 'cancel', operationId: auth.operationId }, signal());
    if (mutation === 'restart') await start();
    if (mutation === 'configuration') await sources.configure(id, { changed: true }, signal());
    const installed = store.installation(manifest.id)!;
    if (mutation === 'removal') store.markMissing(manifest.id, installed.generation);
    if (mutation === 'update') store.activate(installed.manifest, 'b'.repeat(64), installed.generation);
    if (mutation === 'deletion') await sources.delete(id);
    pending.resolve({ ok: true, value: { kind: 'complete' }, nextPrivateState: { obsolete: 'credential' } });
    await expect(poll).rejects.toMatchObject({ code: 'stale_call' });
    expect(store.capture(id)?.privateState).not.toEqual({ obsolete: 'credential' });
    if (mutation === 'cancel') expect((await sources.authentication(id))?.step).toEqual({ kind: 'cancelled' });
    if (mutation === 'update' || mutation === 'configuration') expect(await sources.authentication(id)).toBeNull();
  });
}

test('cancellation is committed before upstream cleanup and ignores a cleanup response that claims completion', async () => {
  const entered = gate<void>(); const cleanup = gate<Outcome<AuthStep>>();
  const { id, sources, store, start } = await setup(async (_ctx, action) => {
    if (action.kind === 'start') return { ok: true, value: waiting() };
    entered.resolve(); return cleanup.promise;
  });
  const auth = await start(); const cancel = sources.authenticate(id, { kind: 'cancel', operationId: auth.operationId }, signal()); await entered.promise;
  expect((await sources.authentication(id))?.step).toEqual({ kind: 'cancelled' });
  cleanup.resolve({ ok: true, value: { kind: 'complete' }, nextPrivateState: { mustNotPersist: true } }); await cancel;
  expect(store.capture(id)?.privateState).toBeNull();
});

test('expired in-flight authorization cannot commit credentials even if upstream reports success', async () => {
  const entered = gate<void>(); const pending = gate<Outcome<AuthStep>>();
  const { id, store, sources, start, setTime } = await setup(async (_ctx, action) => {
    if (action.kind === 'start') return { ok: true, value: waiting() };
    entered.resolve(); return pending.promise;
  });
  const auth = await start(); const poll = sources.authenticate(id, { kind: 'poll', operationId: auth.operationId, challengeId: 'fixture-challenge' }, signal()); await entered.promise;
  setTime(now + 60_001); expect((await sources.authentication(id))?.step?.kind).toBe('expired');
  pending.resolve({ ok: true, value: { kind: 'complete' }, nextPrivateState: { expiredToken: true } });
  expect(await poll).toMatchObject({ ok: true, value: { step: { kind: 'expired' } } }); expect(store.capture(id)?.privateState).toBeNull();
});

test('concurrent polling uses persistent CAS across coordinators', async () => {
  const gates = [gate<Outcome<AuthStep>>(), gate<Outcome<AuthStep>>()]; const entered = [gate<void>(), gate<void>()]; let calls = 0;
  const { id, store, sources, registry, start } = await setup(async (_ctx, action) => {
    if (action.kind === 'start') return { ok: true, value: waiting() };
    const index = calls++; entered[index]!.resolve(); return gates[index]!.promise;
  });
  const auth = await start(); const action = { kind: 'poll' as const, operationId: auth.operationId, challengeId: 'fixture-challenge' };
  const first = sources.authenticate(id, action, signal()); await entered[0]!.promise;
  const second = createSources(store, registry, fetch, () => now).authenticate(id, action, signal()); await entered[1]!.promise;
  gates[1]!.resolve({ ok: true, value: waiting('new-challenge'), nextPrivateState: { accepted: 2 } }); await second;
  gates[0]!.resolve({ ok: true, value: { kind: 'complete' }, nextPrivateState: { obsolete: 1 } });
  await expect(first).rejects.toMatchObject({ code: 'stale_call' }); expect(store.capture(id)?.privateState).toEqual({ accepted: 2 });
});

test('confirmed authorization invalidates an older content result even without a private-state write', async () => {
  const { id, sources, plugin, start } = await setup(async (_ctx, action) => ({ ok: true, value: action.kind === 'start' ? waiting() : { kind: 'complete' } }));
  const auth = await start(); const entered = gate<void>();
  const result = gate<Awaited<ReturnType<SourcePlugin['roots']>>>();
  plugin.roots = async () => { entered.resolve(); return result.promise; };
  const listing = sources.roots(id, signal()); await entered.promise;
  await sources.authenticate(id, { kind: 'poll', operationId: auth.operationId, challengeId: 'fixture-challenge' }, signal());
  result.resolve({ ok: true, value: { items: [] } }); await expect(listing).rejects.toMatchObject({ code: 'stale_call' });
});

test('cancellation preserves a credential renewal that wins immediately before its epoch advance', async () => {
  const { id, store, registry, start } = await setup(async (_ctx, action) => ({ ok: true, value: action.kind === 'start' ? waiting() : { kind: 'cancelled' } }));
  const auth = await start();
  const competing = createSources({ ...store, advanceAuthentication(snapshot, next) {
    expect(store.saveState(snapshot, { renewed: true })).toBe(true);
    return store.advanceAuthentication(snapshot, next);
  } }, registry, fetch, () => now);
  expect(await competing.authenticate(id, { kind: 'cancel', operationId: auth.operationId }, signal())).toMatchObject({ ok: true, value: { step: { kind: 'cancelled' } } });
  expect(store.capture(id)?.privateState).toEqual({ renewed: true });
});

test('a plugin ignoring an aborted poll still cannot publish credentials', async () => {
  const entered = gate<void>(); const result = gate<Outcome<AuthStep>>();
  const { id, sources, store, start } = await setup(async (_ctx, action) => {
    if (action.kind === 'start') return { ok: true, value: waiting() };
    entered.resolve(); return result.promise;
  });
  const auth = await start(); const abort = new AbortController();
  const poll = sources.authenticate(id, { kind: 'poll', operationId: auth.operationId, challengeId: 'fixture-challenge' }, abort.signal); await entered.promise;
  abort.abort(new Error('Fixture authentication cancelled'));
  result.resolve({ ok: true, value: { kind: 'complete' }, nextPrivateState: { obsolete: true } });
  await expect(poll).rejects.toThrow('Fixture authentication cancelled'); expect(store.capture(id)?.privateState).toBeNull();
});

test('a plugin updated between starting and recapturing authentication never runs old code under the new revision', async () => {
  let calls = 0;
  const { id, store, registry } = await setup(async () => { calls++; return { ok: true, value: waiting() }; });
  const competing = createSources({ ...store, advanceAuthentication(snapshot, next) {
    const saved = store.advanceAuthentication(snapshot, next); const installed = store.installation(manifest.id)!;
    store.activate(installed.manifest, 'b'.repeat(64), installed.generation); return saved;
  } }, registry, fetch, () => now);
  await expect(competing.authenticate(id, { kind: 'start' }, signal())).rejects.toMatchObject({ code: 'stale_call' }); expect(calls).toBe(0);
});

test('malformed authentication steps cannot publish private state or unexpected fields', async () => {
  const { id, store, sources } = await setup(async () => ({ ok: true, value: { kind: 'complete', password: 'fixture-not-public' } as AuthStep, nextPrivateState: { invalid: true } }));
  await expect(sources.authenticate(id, { kind: 'start' }, signal())).rejects.toMatchObject({ code: 'plugin_failure' });
  expect(store.capture(id)?.privateState).toBeNull(); expect((await sources.authentication(id))?.step).toBeNull();
});

test('source-provided QR images allow only bounded embedded PNG or JPEG', async () => {
  const { sources, plugin, id } = await setup(async () => ({ ok: true, value: { ...waiting(), qrImage: 'data:image/png;base64,YWJj' } }));
  expect(await sources.authenticate(id, { kind: 'start' }, signal())).toMatchObject({ ok: true, value: { step: { qrImage: 'data:image/png;base64,YWJj' } } });
  for (const invalid of ['https://external.example/track.png', 'data:image/svg+xml;base64,YWJj', 'data:image/png;base64,' + 'A'.repeat(350_000)]) {
    plugin.authenticate = async () => ({ ok: true, value: { ...waiting(), qrImage: invalid } });
    await expect(sources.authenticate(id, { kind: 'start' }, signal())).rejects.toMatchObject({ code: 'plugin_failure' });
  }
});

test('HTTP authentication validates actions and strips all private host and plugin state', async () => {
  const { id, store, sources } = await setup(async () => ({ ok: true, value: waiting(), nextPrivateState: { password: 'fixture-secret' } }));
  const installed = store.installation(manifest.id)!;
  const api = createManagementApi({ host: 'desktop', adminToken: 'fixture-admin', sources, library: createLibrary(sources, store), extensions: createExtensions(store, async () => {}), maxPackageBytes: 100_000, install: async () => installed });
  const headers = { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' };
  const started = await api.request(`/api/instances/${id}/authentication`, { method: 'POST', headers, body: JSON.stringify({ kind: 'start' }) });
  const body = await started.text(); expect(started.status).toBe(200); expect(started.headers.get('Cache-Control')).toBe('no-store');
  for (const field of ['privateState', 'nextPrivateState', 'password', 'fixture-secret', 'stamp', 'pluginRevision']) expect(body).not.toContain(field);
  expect((await api.request(`/api/instances/${id}/authentication`, { method: 'POST', headers, body: JSON.stringify({ kind: 'poll', operationId: 'invalid', challengeId: 'x' }) })).status).toBe(400);
  expect((await api.request(`/api/instances/${id}/authentication`)).status).toBe(401);
});
