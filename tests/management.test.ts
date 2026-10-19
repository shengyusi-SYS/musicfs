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

let archive: Uint8Array; const cleanups: (() => Promise<void>)[] = [];
beforeAll(async () => { archive = await buildSample(); });
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const admin = 'Bearer fixture-admin-token'; const reader = 'Basic ' + Buffer.from('reader:fixture-dav-password').toString('base64');

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-management-'));
  let service = await createDesktopService({ directory, adminToken: 'fixture-admin-token', dav: { username: 'reader', password: 'fixture-dav-password' } });
  let server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: service.app.fetch });
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers); if (!headers.has('Authorization')) headers.set('Authorization', admin);
    return fetch(new URL(path, server.url), { ...init, headers });
  };
  cleanups.push(async () => { await server.stop(true); service.close(); await rm(directory, { recursive: true, force: true }); });
  return { request, async restart() {
    await server.stop(true); service.close();
    service = await createDesktopService({ directory, adminToken: 'fixture-admin-token', dav: { username: 'reader', password: 'fixture-dav-password' } });
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: service.app.fetch });
  } };
}
const body = (value: unknown) => ({ body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } });

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
  expect((await request(`/api/instances/${a}/refresh`, { method: 'POST', ...body({ directoryRef: '/' }) })).status).toBe(200);
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
  const api = createManagementApi({ host: 'desktop', adminToken: 'fixture-admin-token', sources, extensions: createExtensions(store, async () => {}), library: createLibrary(sources, store), maxPackageBytes: 1024, install: async () => installation });
  for (const failed of [false, true]) {
    module.validateConfig = async (_ctx, config) => ({ ...(failed ? { ok: false as const, error: { kind: 'invalid_config' as const, message: 'Fixture validation failure' } } : { ok: true as const, value: config }), nextPrivateState: { token: failed ? 'fixture-renewed-token' : 'fixture-private-token' } });
    const response = await api.request(`/api/instances/${instance.value.id}/config`, { method: 'PUT', headers: { Authorization: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ config: {} }) });
    expect(response.status).toBe(failed ? 422 : 200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text(); expect(text).not.toContain('nextPrivateState'); expect(text).not.toContain('token');
    expect(store.capture(instance.value.id)?.privateState).toEqual({ token: failed ? 'fixture-renewed-token' : 'fixture-private-token' });
  }
  const denied = await api.request('/api/connection', { headers: { Authorization: reader } }); expect(denied.status).toBe(400);
});
