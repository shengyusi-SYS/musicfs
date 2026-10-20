import { afterEach, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { AuthStep, Outcome, SourcePlugin } from '@musicfs/plugin-api';
import type { AuthenticationAction, AuthenticationSession } from '../src/contracts/management';
import { createExtensions, parseManifest, type PluginRegistry } from '../src/core/extensions';
import { createSources } from '../src/core/sources';
import { createLibrary } from '../src/core/library';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import { createManagementApi } from '../src/transport/http';
import { createDav } from '../src/transport/dav';
import fixture, { fixtureManifest } from './fixtures/authentication-plugin';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const signal = () => new AbortController().signal;
const gate = <T>() => Promise.withResolvers<T>();
const json = (value: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const reader = 'Basic ' + Buffer.from('reader:fixture-reader').toString('base64');

async function setup() {
  const store = openSqlite(':memory:'); cleanups.push(store.close);
  const installed = store.activate(parseManifest(fixtureManifest, 'desktop'), 'a'.repeat(64), null);
  const plugin: SourcePlugin = { ...fixture };
  const registry: PluginRegistry = {
    async get(id) { const current = store.installation(id)!; return { ...current, module: plugin }; },
    async isCurrent(id, revision, generation) {
      const current = store.installation(id);
      return current?.status === 'active' && current.revision === revision && current.generation === generation;
    }
  };
  const sources = createSources(store, registry); const library = createLibrary(sources, store);
  const extensions = createExtensions(store, async () => {});
  const app = new Hono().route('/', createManagementApi({ host: 'desktop', adminToken: 'fixture-admin', sources, library, extensions,
    install: async () => installed, remove: id => extensions.remove(id), maxPackageBytes: 100_000 }))
    .route('/', createDav(library.files, { username: 'reader', password: 'fixture-reader' }));
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers); if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer fixture-admin');
    return app.request(path, { ...init, headers });
  };
  async function create(name: string) {
    const response = await request('/api/instances', { method: 'POST', ...json({ pluginId: fixtureManifest.id, name, config: { mode: 'input' } }) });
    expect(response.status).toBe(201);
    return (await response.json() as { value: { id: string } }).value.id;
  }
  async function authenticate(id: string, action: AuthenticationAction) {
    const response = await request(`/api/instances/${id}/authentication`, { method: 'POST', ...json(action) });
    expect(response.status).toBe(200);
    return (await response.json() as { value: AuthenticationSession }).value;
  }
  async function login(id: string) {
    const started = await authenticate(id, { kind: 'start' });
    if (started.step?.kind !== 'input') throw new Error('Expected fixture input challenge');
    const completed = await authenticate(id, { kind: 'submit', operationId: started.operationId, challengeId: started.step.challengeId, input: { code: '123456' } });
    expect(completed.step?.kind).toBe('complete'); return completed;
  }
  return { store, sources, library, plugin, registry, app, request, create, authenticate, login };
}

test('HTTP logout preserves the instance, configuration, layout and another login; cached DAV reads require authentication again', async () => {
  const f = await setup(); const a = await f.create('A'); const b = await f.create('B');
  await f.login(a); await f.login(b);
  const nodes = [{ kind: 'source', id: 'source-a', name: 'A', instanceId: a, sourceId: 'audio' },
    { kind: 'source', id: 'source-b', name: 'B', instanceId: b, sourceId: 'audio' }];
  expect((await f.request('/api/layout', { method: 'PUT', ...json({ expectedRevision: 0, nodes }) })).status).toBe(200);
  const read = (name: string) => f.request(`/dav/${name}/440%20Hz.wav`, { headers: { Authorization: reader, Range: 'bytes=0-3' } });
  expect(await (await read('A')).text()).toBe('RIFF'); expect(await (await read('B')).text()).toBe('RIFF');
  const before = f.store.capture(a)!; const other = f.store.capture(b)!;
  const otherCache = f.store.snapshot(b, { kind: 'roots', ref: '' });
  expect((await f.app.request(`/api/instances/${a}/session`, { method: 'DELETE' })).status).toBe(401);
  expect((await f.request(`/api/instances/${a}/session`, { method: 'DELETE', headers: { Authorization: reader } })).status).toBe(400);
  expect(f.store.capture(a)).toEqual(before);
  f.plugin.authenticate = async () => { throw new Error('Logout must not contact the source'); };
  const response = await f.request(`/api/instances/${a}/session`, { method: 'DELETE' });
  expect(response.status).toBe(204); expect(await response.text()).toBe(''); expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(f.store.capture(a)).toEqual({ ...before, privateState: null, authentication: null, epoch: before.epoch + 1, stateRevision: before.stateRevision + 1 });
  expect(await (await f.request('/api/layout')).json()).toEqual({ revision: 1, nodes });
  expect(await (await f.request(`/api/instances/${a}/authentication`)).json()).toBeNull();
  expect(await createSources(f.store, f.registry).authentication(a)).toBeNull();
  expect((await read('A')).status).toBe(503);
  const roots = await f.request(`/api/instances/${a}/roots`);
  expect(roots.status).toBe(503); expect(await roots.json()).toMatchObject({ sourceError: { kind: 'needs_auth' } });
  expect(await f.library.directoryStatus(a, '/')).toBeNull();
  expect(f.store.capture(b)).toEqual(other); expect(f.store.snapshot(b, { kind: 'roots', ref: '' })).toEqual(otherCache);
  expect(await (await read('B')).text()).toBe('RIFF');
  f.plugin.authenticate = fixture.authenticate!;
  await f.login(a); expect(await (await read('A')).text()).toBe('RIFF');
  expect(f.store.instances().map(instance => instance.id)).toEqual([a, b]);
});

test('logout fences a pending authentication completion, including its private credentials', async () => {
  const f = await setup(); const id = await f.create('A');
  const started = await f.authenticate(id, { kind: 'start' });
  if (started.step?.kind !== 'input') throw new Error('Expected fixture input challenge');
  const entered = gate<void>(); const result = gate<Outcome<AuthStep>>();
  f.plugin.authenticate = async () => { entered.resolve(); return result.promise; };
  const pending = f.request(`/api/instances/${id}/authentication`, { method: 'POST', ...json({
    kind: 'submit', operationId: started.operationId, challengeId: started.step.challengeId, input: { code: '123456' }
  }) });
  await entered.promise;
  expect((await f.request(`/api/instances/${id}/session`, { method: 'DELETE' })).status).toBe(204);
  result.resolve({ ok: true, value: { kind: 'complete' }, nextPrivateState: { token: 'obsolete-credential' } });
  const rejected = await pending; expect(rejected.status).toBe(409); expect(await rejected.json()).toMatchObject({ error: 'stale_call' });
  expect(f.store.capture(id)?.privateState).toBeNull(); expect(await f.sources.authentication(id)).toBeNull();
});

test('logout fences a pending refresh and its proposed state instead of publishing obsolete content', async () => {
  const f = await setup(); const id = await f.create('A'); await f.login(id);
  const entered = gate<void>(); const result = gate<Awaited<ReturnType<SourcePlugin['roots']>>>();
  f.plugin.roots = async () => { entered.resolve(); return result.promise; };
  const refresh = await f.library.refreshes.start(id, { kind: 'directory' });
  const pending = f.library.refreshes.step(refresh.operationId, signal()); await entered.promise;
  expect((await f.request(`/api/instances/${id}/session`, { method: 'DELETE' })).status).toBe(204);
  result.resolve({ ok: true, value: { items: [{ sourceId: 'old', name: 'Old private content', directoryRef: 'old' }] },
    nextPrivateState: { token: 'obsolete-from-refresh' } });
  expect((await pending).status).toBe('superseded');
  expect(f.store.capture(id)?.privateState).toBeNull(); expect(f.store.snapshot(id, { kind: 'roots', ref: '' })?.value).toBeNull();
  f.plugin.roots = fixture.roots;
  expect(await f.sources.roots(id, signal())).toMatchObject({ ok: false, error: { kind: 'needs_auth' } });
});
