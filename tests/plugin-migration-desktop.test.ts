import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopService } from '../src/hosts/desktop/service';
import type { PluginChange } from '../src/contracts/plugin-changes';
import { requestReady } from '../scripts/helpers/refresh-http';
import { desktopMigrationFixture } from './fixtures/desktop-migration';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const admin = 'Bearer fixture-migration-admin';
const reader = 'Basic ' + Buffer.from('reader:fixture-password').toString('base64');
const json = (value: unknown) => ({ body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } });
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Fixture did not reach its checkpoint'); await Bun.sleep(5); }
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-migration-'));
  const options = { directory, adminToken: 'fixture-migration-admin', dav: { username: 'reader', password: 'fixture-password' } };
  let service = await createDesktopService(options);
  const raw = async (path: string, init: RequestInit = {}) => service.app.request(path, { ...init, headers: { Authorization: admin, ...init.headers } });
  const request = (path: string, init: RequestInit = {}) => requestReady(raw, path, init, { Authorization: admin });
  cleanups.push(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const v1 = desktopMigrationFixture(1); const v2 = desktopMigrationFixture(2);
  expect((await raw('/api/plugins', { method: 'POST', body: new Uint8Array(v1.archive) })).status).toBe(201);
  const create = async (label: string, server: string, reject = false) => {
    const response = await raw('/api/instances', { method: 'POST', ...json({ pluginId: v1.manifest.id, name: label, config: { label, server, reject } }) });
    expect(response.status).toBe(201); return (await response.json() as { value: { id: string } }).value.id;
  };
  const upgrade = async () => {
    const response = await raw('/api/plugins', { method: 'POST', body: new Uint8Array(v2.archive) }); expect(response.status).toBe(202);
    return await response.json() as PluginChange;
  };
  const completed = async (id: string) => {
    let view: PluginChange;
    await until(async () => { view = await (await raw(`/api/plugin-changes/${id}`)).json() as PluginChange; return ['completed', 'failed'].includes(view.status); });
    return view!;
  };
  return { raw, request, create, upgrade, completed, pluginId: v1.manifest.id, store: () => service.store,
    async restart(beforeStart?: (directory: string) => void) { await service.close(); beforeStart?.(directory); service = await createDesktopService(options); } };
}

test('desktop HTTP upgrade atomically migrates two instances, rejects an old in-flight DAV result and survives restart', async () => {
  let hold = false; let started = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/stat' && hold) { started = true; await gate; return new Response('late'); }
    return new Response('ready');
  } });
  cleanups.push(async () => { release(); await upstream.stop(true); });
  const service = await setup(); const origin = upstream.url.origin;
  const a = await service.create('甲', origin); const b = await service.create('乙', origin);
  const nodes = [{ kind: 'source', id: 'music', name: '音乐', instanceId: a, sourceId: 'audio' }];
  expect((await service.raw('/api/layout', { method: 'PUT', ...json({ expectedRevision: 0, nodes }) })).status).toBe(200);
  const path = '/dav/' + ['音乐', 'fixture.wav'].map(encodeURIComponent).join('/');
  expect((await service.request(path, { method: 'HEAD', headers: { Authorization: reader } })).status).toBe(200);
  const previous = service.store().installation(service.pluginId)!;
  const before = [a, b].map(id => service.store().capture(id)!);
  hold = true;
  const oldRead = service.raw(path, { method: 'HEAD', headers: { Authorization: reader } }); await until(() => started);
  const operation = await service.upgrade(); expect((await service.completed(operation.operationId)).status).toBe('completed');
  release(); expect((await oldRead).status).toBe(503);
  expect(service.store().installation(service.pluginId)).toMatchObject({ generation: previous.generation + 1, manifest: { configVersion: 2, stateVersion: 2 } });
  for (const instance of before) expect(service.store().capture(instance.id)).toMatchObject({ id: instance.id, name: instance.name,
    config: { title: instance.name, endpoint: origin }, privateState: { session: `fixture-secret-${instance.id}`, version: 2 },
    epoch: instance.epoch + 1, stateRevision: instance.stateRevision + 1, authentication: null });
  expect(await (await service.raw('/api/layout')).json()).toEqual({ revision: 1, nodes });
  await service.restart();
  expect(await (await service.request(`/api/instances/${b}/roots`)).json()).toMatchObject([{ name: '乙' }]);
  expect(await (await service.request(path, { headers: { Authorization: reader, Range: 'bytes=0-3' } })).text()).toBe('RIFF');
});

test('a failed candidate keeps every active instance and old installation, without exposing a plugin exception', async () => {
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ready') });
  cleanups.push(async () => { await upstream.stop(true); });
  const service = await setup();
  const a = await service.create('甲', upstream.url.origin); const b = await service.create('乙', upstream.url.origin, true);
  const previous = service.store().installation(service.pluginId);
  const before = [a, b].map(id => service.store().capture(id));
  const operation = await service.upgrade(); const failed = await service.completed(operation.operationId);
  expect(failed).toMatchObject({ status: 'failed', error: { code: 'migration_failed' } });
  expect(JSON.stringify(failed)).not.toContain('fixture-secret');
  expect(service.store().installation(service.pluginId)).toEqual(previous);
  expect([a, b].map(id => service.store().capture(id))).toEqual(before);
  await service.restart();
  expect(await (await service.request(`/api/instances/${b}/roots`)).json()).toMatchObject([{ name: '乙' }]);
});

test('desktop restart waits out an abandoned lease and resumes the upgrade without an open management page', async () => {
  let candidateStarted = false;
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/candidate' && !candidateStarted) {
      candidateStarted = true;
      return new Promise<Response>(resolve => {
        request.signal.addEventListener('abort', () => resolve(new Response('cancelled')), { once: true });
      });
    }
    return new Response('ready');
  } });
  cleanups.push(async () => { await upstream.stop(true); });
  const service = await setup(); const id = await service.create('恢复', upstream.url.origin);
  const operation = await service.upgrade(); await until(() => candidateStarted);
  await service.restart(directory => {
    const interrupted = openSqlite(join(directory, 'state.sqlite')); const now = Date.now();
    try { expect(interrupted.claimChange(operation.operationId, 'interrupted-process', now, now + 120)).not.toBeNull(); }
    finally { interrupted.close(); }
  });
  // Read only the store: startup's background runner must complete without GET-driven wakes.
  await until(() => service.store().changeRecord(operation.operationId)?.view.status === 'completed');
  expect(service.store().capture(id)).toMatchObject({ config: { title: '恢复', endpoint: upstream.url.origin }, privateState: { version: 2 } });
  expect(service.store().nextBackgroundWorkAt()).toBeNull();
}, 10_000);
