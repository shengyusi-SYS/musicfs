import { afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopService } from '../src/hosts/desktop/service';
import { buildSample } from '../scripts/build-sample';
import type { SourcePlugin } from '@musicfs/plugin-api';
import { createSources } from '../src/core/sources';
import { createExtensions, parseManifest } from '../src/core/extensions';
import { createLibrary } from '../src/core/library';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import { createManagementApi } from '../src/transport/http';
import manifest from '../plugins/sample/manifest.json';
import { completeRefresh, requestReady } from '../scripts/helpers/refresh-http';
import type { RefreshView } from '../src/contracts/refreshes';
import type { PluginInspection } from '../src/contracts/management';
import { strToU8, unzipSync, zipSync } from 'fflate';

let archive: Uint8Array; const cleanups: (() => Promise<void>)[] = [];
beforeAll(async () => { archive = await buildSample(); });
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const admin = 'Bearer fixture-admin-token'; const reader = 'Basic ' + Buffer.from('reader:fixture-dav-password').toString('base64');

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-management-'));
  let service = await createDesktopService({ directory, adminToken: 'fixture-admin-token', dav: { username: 'reader', password: 'fixture-dav-password' } });
  let server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: service.app.fetch });
  const rawRequest = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers); if (!headers.has('Authorization')) headers.set('Authorization', admin);
    return fetch(new URL(path, server.url), { ...init, headers });
  };
  const request = (path: string, init: RequestInit = {}) => requestReady(rawRequest, path, init, { Authorization: admin });
  cleanups.push(async () => { await server.stop(true); await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { request, rawRequest, async restart() {
    await server.stop(true); await service.close();
    service = await createDesktopService({ directory, adminToken: 'fixture-admin-token', dav: { username: 'reader', password: 'fixture-dav-password' } });
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: service.app.fetch });
  } };
}
const body = (value: unknown) => ({ body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } });

test('plugin inspection reports both compatibility dimensions without installing; URL inspection shares the same checks', async () => {
  const { request } = await setup();
  const compatible = await request('/api/plugins/inspect', { method: 'POST', body: new Uint8Array(archive) });
  expect(compatible.status).toBe(200);
  const preview = await compatible.json() as PluginInspection;
  expect(preview.manifest).toEqual(parseManifest(manifest, 'desktop'));
  expect(preview.revision).toMatch(/^[0-9a-f]{64}$/);
  expect(preview.compatibility).toEqual({ host: 'desktop', apiVersion: '0.1.5', apiCompatible: true, hostCompatible: true });
  const files = unzipSync(archive);
  const incompatible = zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify({ ...manifest, apiRange: '^9.0.0', hosts: { worker: 'index.mjs' } })) });
  const rejected = await request('/api/plugins/inspect', { method: 'POST', body: incompatible });
  expect(rejected.status).toBe(200);
  expect((await rejected.json() as PluginInspection).compatibility).toMatchObject({ apiCompatible: false, hostCompatible: false });
  expect((await request('/api/plugins', { method: 'POST', body: incompatible })).status).toBe(422);
  const malformed = zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify({ ...manifest, version: 'latest' })) });
  expect((await request('/api/plugins/inspect', { method: 'POST', body: malformed })).status).toBe(422);
  const notExecutable = zipSync({ ...files, 'index.mjs': strToU8('throw new Error("Inspection must not execute this module");') });
  expect((await request('/api/plugins/inspect', { method: 'POST', body: notExecutable })).status).toBe(200);
  const release = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(new Uint8Array(archive)) });
  try {
    const viaUrl = await request('/api/plugins/inspect-url', { method: 'POST', ...body({ url: release.url.href }) });
    expect(viaUrl.status).toBe(200); expect(await viaUrl.json()).toEqual(preview);
    expect(await (await request('/api/plugins')).json()).toEqual([]);
    expect((await request('/api/plugins/from-url', { method: 'POST', ...body({ url: release.url.href }) })).status).toBe(201);
    expect((await (await request('/api/plugins')).json() as unknown[]).length).toBe(1);
  } finally { await release.stop(true); }
});

test('HTTP install → independent instances → layout → DAV → restart → remove/reinstall', async () => {
  const { request, restart } = await setup();
  expect((await request('/api/plugins', { method: 'POST', body: new Uint8Array(archive) })).status).toBe(201);
  const schema = await (await request('/api/plugins/org.musicfs.sample/configuration')).json() as { authentication: boolean; configuration: { schema: unknown } };
  expect(schema.authentication).toBe(false); expect(schema.configuration.schema).toBeDefined();
  const create = async (name: string, label: string) => {
    const response = await request('/api/instances', { method: 'POST', ...body({ pluginId: 'org.musicfs.sample', name, config: { label } }) });
    expect(response.status).toBe(201); return (await response.json() as { value: { id: string } }).value.id;
  };
  const a = await create('A', '甲'); const b = await create('B', '乙');
  const roots = await (await request(`/api/instances/${a}/roots`)).json() as { sourceId: string }[]; expect(roots[0]?.sourceId).toBe('audio');
  const nodes = [{ kind: 'group', id: 'music', name: '音乐', children: [
    { kind: 'source', id: 'a', name: '甲', instanceId: a, sourceId: 'audio' },
    { kind: 'source', id: 'b', name: '乙', instanceId: b, sourceId: 'audio' }
  ] }];
  expect((await request('/api/layout', { method: 'PUT', ...body({ expectedRevision: 0, nodes }) })).status).toBe(200);
  const path = '/dav/' + ['音乐', '甲', '440 Hz.wav'].map(encodeURIComponent).join('/');
  expect(await (await request(path, { headers: { Authorization: reader, Range: 'bytes=0-3' } })).text()).toBe('RIFF');
  expect((await request(`/api/instances/${a}/config`, { method: 'PUT', ...body({ config: { label: '甲新设置' } }) })).status).toBe(200);
  expect(await (await request(`/api/instances/${b}/roots`)).json()).toMatchObject([{ name: '乙' }]);
  const completed = await completeRefresh(request, await request(`/api/instances/${a}/refresh`, { method: 'POST', ...body({ directoryRef: '/' }) }), '/', { Authorization: admin });
  expect(completed.status).toBe('completed'); expect(completed.refreshedDirectories).toBe(1);
  expect(await (await request('/api/library?path=' + encodeURIComponent('/音乐/甲'))).json()).toMatchObject([{ name: '440 Hz.wav' }]);
  expect(await (await request('/api/layout')).json()).toEqual({ revision: 1, nodes });
  await restart();
  expect((await (await request('/api/instances')).json() as unknown[]).length).toBe(2);
  expect(await (await request(path, { headers: { Authorization: reader, Range: 'bytes=0-3' } })).text()).toBe('RIFF');
  expect((await request('/api/plugins/org.musicfs.sample', { method: 'DELETE' })).status).toBe(204);
  expect((await (await request('/api/instances')).json() as unknown[]).length).toBe(2);
  const unavailable = await request(path, { headers: { Authorization: reader } }); expect(unavailable.status).toBe(503); await unavailable.body?.cancel();
  expect((await request('/api/plugins', { method: 'POST', body: new Uint8Array(archive) })).status).toBe(201);
  expect(await (await request(path, { headers: { Authorization: reader, Range: 'bytes=0-3' } })).text()).toBe('RIFF');
  expect((await request(`/api/instances/${a}`, { method: 'DELETE' })).status).toBe(204);
  expect((await (await request('/api/instances')).json() as unknown[]).length).toBe(1);
});

test('refresh HTTP accepts without reading, advances one page per request and restores or cancels the same persistent operation', async () => {
  const store = openSqlite(':memory:'); cleanups.push(async () => store.close());
  const installation = store.activate(parseManifest(manifest, 'desktop'), 'b'.repeat(64), null);
  const calls: (string | undefined)[] = [];
  const source: SourcePlugin = {
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, value) => ({ ok: true, value, nextPrivateState: { token: 'fixture-secret-token' } }),
    roots: async (_ctx, cursor) => { calls.push(cursor); return { ok: true, value: { items: [{ sourceId: cursor ? 'b' : 'a', name: cursor ? '乙' : '甲', directoryRef: cursor ? 'b' : 'a' }],
      statistics: { records: 1 }, ...(cursor ? {} : { nextCursor: 'fixture-private-cursor' }) } }; },
    list: async () => ({ ok: true, value: { items: [] } }),
    stat: async () => ({ ok: false, error: { kind: 'not_supported', message: 'Unused' } }),
    open: async () => ({ ok: false, error: { kind: 'not_supported', message: 'Unused' } })
  };
  const sources = createSources(store, { get: async () => ({ ...installation, module: source }), isCurrent: async () => true });
  const created = await sources.create(manifest.id, '分页实例', {}, new AbortController().signal); if (!created.ok) throw new Error('Fixture creation failed');
  const library = createLibrary(sources, store, undefined, { execution: 'deferred' });
  const extensions = createExtensions(store, async () => {});
  const api = createManagementApi({ host: 'desktop', adminToken: 'fixture-admin-token', sources, library, extensions, remove: id => extensions.remove(id), maxPackageBytes: 1024, install: async () => installation });
  const request = (path: string, init: RequestInit = {}) => api.request(path, { ...init, headers: { Authorization: admin, ...init.headers } });
  const base = `/api/instances/${created.value.id}`;
  expect(await (await request(`${base}/refresh`)).json()).toBeNull();
  const cold = await request(`${base}/roots`); expect(cold.status).toBe(503); expect(cold.headers.get('Retry-After')).toBe('2');
  const coldId = cold.headers.get('X-MusicFS-Refresh'); expect(coldId).toBeString();
  expect(await cold.json()).toMatchObject({ error: 'refresh_pending', operationId: coldId });
  const repeated = await request(`${base}/roots`); expect(repeated.headers.get('X-MusicFS-Refresh')).toBe(coldId); await repeated.body?.cancel(); expect(calls).toEqual([]);
  const accepted = await request(`${base}/refresh`, { method: 'POST', ...body({}) }); expect(accepted.status).toBe(202);
  const queued = await accepted.json() as RefreshView; expect(accepted.headers.get('X-MusicFS-Refresh')).toBe(queued.operationId); expect(queued.status).toBe('queued');
  const resource = `/api/refreshes/${queued.operationId}`;
  expect((await (await request(`${base}/refresh`)).json() as RefreshView).operationId).toBe(queued.operationId);
  expect((await (await request(resource)).json() as RefreshView).status).toBe('queued'); expect(calls).toEqual([]);
  const first = await request(`${resource}/step`, { method: 'POST' }); expect(first.status).toBe(200);
  expect(first.headers.get('X-MusicFS-Refresh')).toBeNull();
  const firstText = await first.text(); expect(firstText).not.toContain('fixture-private-cursor'); expect(firstText).not.toContain('fixture-secret-token');
  expect(JSON.parse(firstText)).toMatchObject({ status: 'running', current: { pages: 1, entries: 1, statistics: { records: 1 } } });
  expect(calls).toEqual([undefined]);
  const stillCold = await request(`${base}/roots`); expect(stillCold.status).toBe(503); expect(stillCold.headers.get('X-MusicFS-Refresh')).toBe(queued.operationId); await stillCold.body?.cancel();
  expect((await (await request(resource)).json() as RefreshView).current?.pages).toBe(1); expect(calls).toEqual([undefined]);
  const second = await request(`${resource}/step`, { method: 'POST' }); expect(second.status).toBe(200);
  expect(await second.json()).toMatchObject({ status: 'completed', current: { pages: 2, entries: 2, statistics: { records: 2 } } });
  expect(calls).toEqual([undefined, 'fixture-private-cursor']);
  expect(await (await request(`${base}/roots`)).json()).toMatchObject([{ sourceId: 'a' }, { sourceId: 'b' }]);
  const next = await request(`${base}/refresh`, { method: 'POST', ...body({ directoryRef: 'a' }) });
  const nextJob = await next.json() as RefreshView; expect(next.status).toBe(202);
  const cancelled = await request(`/api/refreshes/${nextJob.operationId}`, { method: 'DELETE' }); expect(cancelled.status).toBe(200); expect(await cancelled.json()).toMatchObject({ status: 'cancelled' });
  expect((await (await request(`/api/refreshes/${nextJob.operationId}/step`, { method: 'POST' })).json() as RefreshView).status).toBe('cancelled');
  expect(calls).toHaveLength(2);
  expect((await request('/api/refreshes/unknown')).status).toBe(404); expect((await request('/api/refreshes/unknown', { method: 'DELETE' })).status).toBe(404);
});

test('DAV credentials cannot manage plugins or settings; invalid JSON and settings are rejected', async () => {
  const { request } = await setup();
  const denied = await request('/api/plugins', { method: 'POST', headers: { Authorization: reader }, body: new Uint8Array(archive) });
  expect(denied.status).toBe(400); expect(denied.headers.get('WWW-Authenticate')).toContain('Bearer'); await denied.body?.cancel();
  const wrong = await request('/api/layout', { method: 'PUT', ...body({ expectedRevision: 0, nodes: [] }), headers: { Authorization: reader, 'Content-Type': 'application/json' } });
  expect(wrong.status).toBe(400); await wrong.body?.cancel();
  const malformed = await request('/api/instances', { method: 'POST', body: '{broken', headers: { 'Content-Type': 'application/json' } });
  expect(malformed.status).toBe(400); await malformed.body?.cancel();
  await request('/api/plugins', { method: 'POST', body: new Uint8Array(archive) });
  const invalid = await request('/api/instances', { method: 'POST', ...body({ pluginId: 'org.musicfs.sample', name: 'A', config: { label: '' } }) });
  expect(invalid.status).toBe(422); expect(await invalid.json()).toMatchObject({ ok: false, error: { kind: 'invalid_config' } });
});

test('a release URL installs the same prebuilt package without compiling the core', async () => {
  const { request } = await setup();
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(new Uint8Array(archive), { headers: { 'Content-Type': 'application/zip' } }) });
  cleanups.push(async () => { await upstream.stop(true); });
  const installed = await request('/api/plugins/from-url', { method: 'POST', ...body({ url: new URL('/sample.zip', upstream.url).href }) });
  expect(installed.status).toBe(201);
  expect((await (await request('/api/plugins')).json() as unknown[]).length).toBe(1);
  const invalid = await request('/api/plugins/from-url', { method: 'POST', ...body({ url: 'file:///tmp/invalid' }) });
  expect(invalid.status).toBe(400); await invalid.body?.cancel();
});

test('configuration responses never expose private state, on success or failure', async () => {
  const store = openSqlite(':memory:'); cleanups.push(async () => store.close());
  const installation = store.activate(parseManifest(manifest, 'desktop'), 'a'.repeat(64), null);
  const unsupported = async () => ({ ok: false as const, error: { kind: 'not_supported' as const, message: 'Unused fixture operation' } });
  const module: SourcePlugin = { configuration: { schema: { type: 'object' } }, roots: unsupported, list: unsupported, stat: unsupported, open: unsupported,
    validateConfig: async (_ctx, config) => ({ ok: true, value: config, nextPrivateState: { token: 'fixture-private-token' } }) };
  const sources = createSources(store, { get: async () => ({ ...installation, module }), isCurrent: async () => true });
  const instance = await sources.create(manifest.id, '配置隔离', {}, new AbortController().signal); if (!instance.ok) throw new Error('Fixture creation failed');
  const extensions = createExtensions(store, async () => {});
  const api = createManagementApi({ host: 'desktop', adminToken: 'fixture-admin-token', sources, extensions, remove: id => extensions.remove(id), library: createLibrary(sources, store), maxPackageBytes: 1024, install: async () => installation });
  for (const failed of [false, true]) {
    module.validateConfig = async (_ctx, config) => ({ ...(failed ? { ok: false as const, error: { kind: 'invalid_config' as const, message: 'Fixture validation failure' } } : { ok: true as const, value: config }), nextPrivateState: { token: failed ? 'fixture-renewed-token' : 'fixture-private-token' } });
    const response = await api.request(`/api/instances/${instance.value.id}/config`, { method: 'PUT', headers: { Authorization: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ config: {} }) });
    expect(response.status).toBe(failed ? 422 : 200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text(); expect(text).not.toContain('nextPrivateState'); expect(text).not.toContain('token');
    expect(store.capture(instance.value.id)?.privateState).toEqual({ token: failed ? 'fixture-renewed-token' : 'fixture-private-token' });
  }
  const denied = await api.request('/api/connection', { headers: { Authorization: reader } }); expect(denied.status).toBe(400);
});
