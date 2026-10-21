import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Log, LogLevel, Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { Entry, SourcePlugin } from '@musicfs/plugin-api';
import { parseManifest } from '../src/core/extensions';
import { createLibrary } from '../src/core/library';
import { createSources } from '../src/core/sources';
import { createD1Store } from '../src/infrastructure/persistence/d1';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import { createManagementApi } from '../src/transport/http';
import manifest from '../plugins/sample/manifest.json';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
const entry = (id: string): Entry => ({ kind: 'file', entryId: id, name: `${id}.wav`, fileRef: id });
async function setup(adapter: 'SQLite' | 'D1') {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-schedules-'));
  let now = Date.UTC(2026, 9, 21); let calls = 0;
  let store: ReturnType<typeof openSqlite> | ReturnType<typeof createD1Store>;
  let reopen: () => void;
  if (adapter === 'SQLite') {
    const path = join(directory, 'state.sqlite'); let db = openSqlite(path); store = db;
    reopen = () => { db.close(); db = openSqlite(path); store = db; };
    cleanups.push(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  } else {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("schedule fixture")}}',
      compatibilityDate: '2026-07-30', d1Databases: { DB: 'schedules-tests' }, d1Persist: directory, log: new Log(LogLevel.ERROR) });
    cleanups.push(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()).replace(/^[\s]*--.*$/gm, '').replaceAll('\n', ' '));
    }
    store = createD1Store(db); reopen = () => { store = createD1Store(db); };
  }
  const installation = await store.activate(parseManifest(manifest, 'desktop'), 'a'.repeat(64), null);
  const plugin: SourcePlugin = {
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, value) => ({ ok: true, value }),
    roots: async () => ({ ok: true, value: { items: [{ sourceId: 'music', name: '音乐', directoryRef: 'music' }] } }),
    list: async () => { calls++; return { ok: true, value: { items: [entry('old')] } }; },
    stat: async () => ({ ok: false, error: { kind: 'not_supported', message: 'Unused' } }),
    open: async () => ({ ok: false, error: { kind: 'not_supported', message: 'Unused' } })
  };
  const build = () => {
    const sources = createSources(store, { get: async () => ({ ...installation, module: plugin }), isCurrent: async () => true });
    return { sources, library: createLibrary(sources, store, undefined, { execution: 'deferred', now: () => now }) };
  };
  let services = build();
  const created = await services.sources.create(manifest.id, '实例', {}, signal()); if (!created.ok) throw new Error('Fixture creation failed');
  return { id: created.value.id, plugin, get store() { return store; }, get sources() { return services.sources; },
    get library() { return services.library; }, get calls() { return calls; }, get now() { return now; },
    advance(milliseconds: number) { now += milliseconds; }, reopen() { reopen(); services = build(); } };
}

for (const adapter of ['SQLite', 'D1'] as const) {
  test(`${adapter}: a persisted schedule queues one overdue refresh and retains the old snapshot until final publication`, async () => {
    const f = await setup(adapter);
    await f.library.refresh(f.id, undefined, signal()); await f.library.refresh(f.id, 'music', signal());
    expect(await f.library.schedules.get(f.id, 'music')).toEqual({ intervalMinutes: 0, nextRunAt: null });
    expect(await f.library.schedules.nextAt()).toBeNull();
    const policy = await f.library.schedules.set(f.id, 15, 'music');
    expect(policy.nextRunAt).toBe(new Date(f.now + 900_000).toISOString());
    expect(await f.library.schedules.get(f.id)).toEqual({ intervalMinutes: 0, nextRunAt: null });
    f.plugin.list = async (_ctx, _ref, cursor) => ({ ok: true, value: { items: [entry(cursor ? 'last' : 'first')], ...(cursor ? {} : { nextCursor: 'last' }) } });
    f.advance(86_400_000); f.reopen();
    expect(await f.library.schedules.get(f.id, 'music')).toEqual(policy);
    const job = (await f.library.schedules.stepNext(signal()))!;
    expect(job.scope).toEqual({ kind: 'directory', directoryRef: 'music' }); expect(job.status).toBe('queued');
    expect(await f.library.schedules.nextAt()).toBeNull();
    expect(await f.library.schedules.stepNext(signal())).toBeNull();
    expect(f.calls).toBe(1);
    expect((await f.library.files.list('/实例/音乐', signal())).map(item => item.name)).toEqual(['old.wav']);
    expect((await f.library.refreshes.step(job.operationId, signal())).status).toBe('running');
    expect((await f.library.files.list('/实例/音乐', signal())).map(item => item.name)).toEqual(['old.wav']);
    f.reopen(); expect((await f.library.refreshes.stepNext(signal()))?.status).toBe('completed');
    expect((await f.library.files.list('/实例/音乐', signal())).map(item => item.name)).toEqual(['first.wav', 'last.wav']);
    expect(await f.library.schedules.nextAt()).toBe(f.now + 900_000);
    expect(await f.library.schedules.stepNext(signal())).toBeNull();
    await f.sources.delete(f.id); expect(await f.store.nextRefreshScheduleAt()).toBeNull();
  });

  test(`${adapter}: due schedules leave active work and source cooldown alone, then fail only once per interval`, async () => {
    const f = await setup(adapter); await f.library.schedules.set(f.id, 15, 'music'); f.advance(900_000);
    let requests = 0;
    f.plugin.list = async () => ++requests === 1
      ? { ok: false, error: { kind: 'rate_limited', message: 'Wait', retryAfterSeconds: 7 } }
      : { ok: true, value: { items: [] } };
    const manual = await f.library.refreshes.start(f.id, { kind: 'directory', directoryRef: 'other' });
    expect(await f.library.schedules.stepNext(signal())).toBeNull(); expect(await f.library.schedules.nextAt()).toBeNull();
    const waiting = await f.library.refreshes.step(manual.operationId, signal()); expect(waiting.retryAt).toBe(new Date(f.now + 7_000).toISOString());
    expect(await f.library.schedules.stepNext(signal())).toBeNull(); expect(await f.library.schedules.nextAt()).toBeNull();
    expect((await f.library.refreshes.current(f.id))?.operationId).toBe(manual.operationId); expect(requests).toBe(1);
    f.advance(7_000); expect((await f.library.refreshes.stepNext(signal()))?.status).toBe('completed');
    f.plugin.list = async () => ({ ok: false, error: { kind: 'unavailable', message: 'Unavailable' } });
    const due = (await f.library.schedules.stepNext(signal()))!; expect(due.scope).toEqual({ kind: 'directory', directoryRef: 'music' });
    expect((await f.library.refreshes.step(due.operationId, signal())).status).toBe('failed');
    expect(await f.library.schedules.nextAt()).toBe(f.now + 900_000); expect(await f.library.schedules.stepNext(signal())).toBeNull();
    expect(await f.library.schedules.set(f.id, 0, 'music')).toEqual({ intervalMinutes: 0, nextRunAt: null });
    expect(await f.library.schedules.nextAt()).toBeNull();
  });
}

test('management refresh policies persist roots and directory choices independently', async () => {
  const f = await setup('SQLite');
  const api = createManagementApi({ host: 'desktop', adminToken: 'fixture-admin', sources: f.sources, library: f.library,
    extensions: { list: () => f.store.installations() }, maxPackageBytes: 1024, install: async () => (await f.store.installations())[0]!, remove: async () => {} });
  const request = (suffix: string, minutes?: number) => api.request(`/api/instances/${f.id}/refresh-policy${suffix}`, {
    method: minutes === undefined ? 'GET' : 'PUT', headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' },
    ...(minutes === undefined ? {} : { body: JSON.stringify({ intervalMinutes: minutes }) })
  });
  expect(await (await request('')).json()).toEqual({ intervalMinutes: 0, nextRunAt: null });
  expect(await (await request('?directoryRef=music', 15)).json()).toEqual({ intervalMinutes: 15, nextRunAt: new Date(f.now + 900_000).toISOString() });
  expect(await (await request('')).json()).toEqual({ intervalMinutes: 0, nextRunAt: null });
  expect(await (await request('', 60)).json()).toEqual({ intervalMinutes: 60, nextRunAt: new Date(f.now + 3_600_000).toISOString() });
  expect((await request('?directoryRef=music', 0)).status).toBe(200);
  expect(await (await request('?directoryRef=music')).json()).toEqual({ intervalMinutes: 0, nextRunAt: null });
});
