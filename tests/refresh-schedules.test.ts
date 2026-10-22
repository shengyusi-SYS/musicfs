import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
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

for (const adapter of ['SQLite', 'D1'] as const) {
  test(`${adapter}: full-instance rules discover new descendants and share overlapping scheduled work`, async () => {
    const f = await setup(adapter); const visited: string[] = [];
    f.plugin.list = async (_ctx, ref) => {
      visited.push(ref);
      return { ok: true, value: { items: ref === 'music'
        ? [{ kind: 'directory', entryId: 'new-playlist', name: '新歌单', directoryRef: 'new-playlist' }]
        : [entry('song'), { kind: 'directory', entryId: 'cycle', name: '回到入口', directoryRef: 'music' }] } };
    };
    const full = await f.library.schedules.create({ instanceId: f.id, enabled: true, label: '全部内容',
      target: { kind: 'instance' }, timing: { kind: 'interval', minutes: 15 } });
    const directory = await f.library.schedules.create({ instanceId: f.id, enabled: true,
      target: { kind: 'directory', directoryRef: 'music', recursive: true }, timing: { kind: 'interval', minutes: 15 } });
    f.advance(900_000);
    const first = (await f.library.schedules.stepNext(signal()))!;
    expect((await f.library.schedules.stepNext(signal()))?.operationId).toBe(first.operationId);
    expect(await f.library.schedules.stepNext(signal())).toBeNull();
    expect(visited).toEqual([]);
    expect((await f.library.schedules.list()).map(rule => rule.operationId)).toEqual([first.operationId, first.operationId]);
    let job = first;
    while (job.status === 'queued' || job.status === 'running') job = await f.library.refreshes.step(job.operationId, signal());
    expect(job.status).toBe('completed'); expect(visited).toEqual(['music', 'new-playlist']);
    expect(job.refreshedDirectories).toBe(2);
    const rules = await f.library.schedules.list();
    expect(rules.find(rule => rule.id === full.id)).toMatchObject({ status: 'completed', nextRunAt: new Date(f.now + 900_000).toISOString() });
    expect(rules.find(rule => rule.id === directory.id)?.operationId).toBe(first.operationId);
  });

  test(`${adapter}: recursive directory rules include unvisited children and report partial failures`, async () => {
    const f = await setup(adapter);
    f.plugin.list = async (_ctx, ref) => ref === 'music'
      ? { ok: true, value: { items: [{ kind: 'directory', entryId: 'child', name: '子目录', directoryRef: 'child' }] } }
      : { ok: false, error: { kind: 'unavailable', message: 'Unavailable child' } };
    const rule = await f.library.schedules.create({ instanceId: f.id, enabled: false,
      target: { kind: 'directory', directoryRef: 'music', recursive: true }, timing: { kind: 'interval', minutes: 15 } });
    let job = await f.library.schedules.run(rule.id, signal());
    while (job.status === 'queued' || job.status === 'running') job = await f.library.refreshes.step(job.operationId, signal());
    expect(job.scope).toEqual({ kind: 'directory', directoryRef: 'music', recursive: true });
    expect(job.status).toBe('completed'); expect(job.failures).toHaveLength(1);
    expect((await f.library.schedules.list())[0]).toMatchObject({ enabled: false, nextRunAt: null, status: 'completed', failedDirectories: 1 });
  });

  test(`${adapter}: intervals anchor to completion and edited active rules retain their association`, async () => {
    const f = await setup(adapter);
    const input = { instanceId: f.id, enabled: true, target: { kind: 'directory', directoryRef: 'music', recursive: false } as const,
      timing: { kind: 'interval', minutes: 15 } as const };
    const rule = await f.library.schedules.create(input); f.advance(900_000);
    const first = (await f.library.schedules.stepNext(signal()))!;
    f.advance(1_800_000);
    const edited = await f.library.schedules.update(rule.id, { ...input, timing: { kind: 'interval', minutes: 60 } });
    expect(edited.operationId).toBe(first.operationId); expect(edited.nextRunAt).toBeNull();
    expect(await f.library.schedules.stepNext(signal())).toBeNull();
    f.advance(1_000); await f.library.refreshes.step(first.operationId, signal());
    f.advance(5_000); // Observer time must not shift the job's actual completion anchor.
    expect(await f.library.schedules.nextAt()).toBe(f.now - 5_000 + 3_600_000);
    expect(await f.library.schedules.stepNext(signal())).toBeNull();
  });

  test(`${adapter}: a race with unrelated foreground work never consumes a due occurrence`, async () => {
    const f = await setup(adapter);
    await f.library.schedules.set(f.id, 15, 'music'); f.advance(900_000);
    let interleaved = false;
    const raced = createLibrary(f.sources, { ...f.store, async createScheduledRefresh(record, claim) {
      if (!interleaved) {
        interleaved = true;
        await f.library.refreshes.start(f.id, { kind: 'directory', directoryRef: 'other' });
      }
      return f.store.createScheduledRefresh(record, claim);
    } }, undefined, { execution: 'deferred', now: () => f.now });
    expect(await raced.schedules.stepNext(signal())).toBeNull();
    expect((await f.library.schedules.get(f.id, 'music')).nextRunAt).toBe(new Date(f.now).toISOString());
    expect(await f.library.schedules.nextAt()).toBeNull();
    await f.library.refreshes.step((await f.library.refreshes.current(f.id))!.operationId, signal());
    const due = (await f.library.schedules.stepNext(signal()))!;
    expect(due.scope).toEqual({ kind: 'directory', directoryRef: 'music' });
  });
}

test('upgrading interval schedules retains their first due instant and roots-only meaning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-schedule-migration-'));
  const path = join(directory, 'old.sqlite');
  const db = new Database(path);
  for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => /^000[1-9]\.sql$|^0010\.sql$/.test(name)).sort()) {
    db.exec(await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text());
  }
  db.query("INSERT INTO installations (id, manifest, revision, generation, status) VALUES (?, ?, ?, 1, 'active')")
    .run(manifest.id, JSON.stringify(manifest), 'a'.repeat(64));
  db.query("INSERT INTO instances (id, plugin_id, name, config, private_state, epoch, state_revision) VALUES ('legacy', ?, '旧来源', '{}', '{}', 1, 1)")
    .run(manifest.id);
  const dueAt = Date.UTC(2026, 9, 25, 4);
  db.query("INSERT INTO refresh_schedules (instance_id, kind, ref, interval_minutes, next_run_at) VALUES ('legacy', 'roots', '', 60, ?)").run(dueAt);
  db.exec('PRAGMA user_version = 10'); db.close();
  const migrated = openSqlite(path);
  try {
    expect(migrated.updateRules()).toHaveLength(1);
    expect(migrated.updateRules()[0]).toMatchObject({ instanceId: 'legacy', enabled: true, target: { kind: 'roots' },
      timing: { kind: 'interval', minutes: 60 }, nextRunAt: dueAt, settled: true });
  } finally { migrated.close(); await rm(directory, { recursive: true, force: true }); }
});

test('management update rules expose calendar targets, reject duplicates on edit, pause and remove', async () => {
  const f = await setup('SQLite');
  const api = createManagementApi({ host: 'desktop', adminToken: 'fixture-admin', sources: f.sources, library: f.library,
    extensions: { list: () => f.store.installations() }, maxPackageBytes: 1024, install: async () => (await f.store.installations())[0]!, remove: async () => {} });
  const request = (path = '', method = 'GET', body?: unknown) => api.request('/api/update-rules' + path, { method,
    headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const input = { instanceId: f.id, enabled: true, label: '整个来源', target: { kind: 'instance' },
    timing: { kind: 'daily', time: '08:00', timezone: 'Asia/Shanghai' } };
  const created = await request('', 'POST', input); expect(created.status).toBe(201);
  const rule = await created.json() as { id: string; nextRunAt: string };
  expect(rule.nextRunAt).toBe('2026-10-22T00:00:00.000Z');
  expect(await (await request()).json()).toHaveLength(1);
  const directory = await f.library.schedules.create({ instanceId: f.id, enabled: true,
    target: { kind: 'directory', directoryRef: 'music', recursive: false }, timing: { kind: 'interval', minutes: 60 } });
  expect((await request('/' + directory.id, 'PUT', input)).status).toBe(409);
  const paused = await request('/' + rule.id, 'PUT', { ...input, enabled: false });
  expect(paused.status).toBe(200); expect(await paused.json()).toMatchObject({ enabled: false, nextRunAt: null });
  const manual = await request('/' + rule.id + '/run', 'POST'); expect(manual.status).toBe(202);
  expect(await manual.json()).toMatchObject({ instanceId: f.id, scope: { kind: 'instance' }, status: 'queued' });
  expect((await request('/' + rule.id, 'DELETE')).status).toBe(204);
  expect(await (await request()).json()).toHaveLength(1);
});

test('run now does not mistake a just-completed associated job for newly requested work', async () => {
  const f = await setup('SQLite');
  const rule = await f.library.schedules.create({ instanceId: f.id, enabled: false,
    target: { kind: 'directory', directoryRef: 'music', recursive: false }, timing: { kind: 'interval', minutes: 15 } });
  const old = await f.library.schedules.run(rule.id, signal());
  await f.library.refreshes.step(old.operationId, signal());
  await f.library.refreshes.start(f.id, { kind: 'directory', directoryRef: 'other' });
  await expect(f.library.schedules.run(rule.id, signal())).rejects.toMatchObject({ code: 'conflict' });
});
