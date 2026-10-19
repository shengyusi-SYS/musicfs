import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Log, LogLevel, Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { Entry, PluginManifest } from '@musicfs/plugin-api';
import type { InstallationStore } from '../src/core/extensions';
import type { InstanceStore, SourceStamp } from '../src/core/sources';
import type { LibraryStore, Snapshot, SnapshotKey } from '../src/core/library/types';
import type { RefreshRecord, RefreshStore, SnapshotHeader } from '../src/core/library/refresh-types';
import { createD1Store } from '../src/infrastructure/persistence/d1';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';

type Store = InstallationStore & InstanceStore & LibraryStore & RefreshStore;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const now = Date.UTC(2026, 9, 20);
const date = new Date(now).toISOString();
const manifest: PluginManifest = { formatVersion: 1, id: 'org.musicfs.fixture', name: 'Fixture', version: '1.0.0', apiRange: '^1.0.0',
  hosts: { desktop: 'index.mjs', worker: 'index.mjs' }, configVersion: 1, stateVersion: 1, files: ['index.mjs'] };
const key: SnapshotKey = { kind: 'directory', ref: 'music' };
const file = (id: string): Entry => ({ kind: 'file', entryId: id, name: `${id}.wav`, fileRef: 'same-content' });
function record(stamp: SourceStamp, id: string, taskKey = key): RefreshRecord {
  return { operationId: id, stamp, scope: { kind: 'instance' }, status: 'queued', revision: 0, leaseToken: null, leaseUntil: null,
    task: { key: taskKey, attemptId: `${id}-attempt`, pages: 0, entries: 0, children: [] }, pending: [], seen: [], known: [],
    refreshedDirectories: 0, failures: [], createdAt: date, updatedAt: date };
}
function next(previous: RefreshRecord, changes: Partial<RefreshRecord> = {}): RefreshRecord {
  return { ...previous, revision: previous.revision + 1, leaseToken: null, leaseUntil: null, ...changes };
}
const header = (current: RefreshRecord, id: string): SnapshotHeader => ({ stamp: current.stamp, kind: current.task!.key.kind, id, completedAt: date });

async function setup(adapter: 'SQLite' | 'D1') {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-refresh-')); let store: Store;
  let reopen: () => void;
  let rows: <T>(sql: string, ...values: (string | number | null)[]) => Promise<T[]>;
  if (adapter === 'SQLite') {
    const path = join(directory, 'state.sqlite'); let current = openSqlite(path); store = current;
    const inspect = new Database(path);
    reopen = () => { current.close(); current = openSqlite(path); store = current; };
    rows = async <T>(sql: string, ...values: (string | number | null)[]) => inspect.query<T, (string | number | null)[]>(sql).all(...values);
    cleanup.push(async () => { current.close(); inspect.close(); await rm(directory, { recursive: true, force: true }); });
  } else {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("D1 refresh fixture")}}',
      compatibilityDate: '2026-07-30', d1Databases: { DB: 'refresh-tests' }, d1Persist: directory, log: new Log(LogLevel.ERROR) });
    cleanup.push(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()).replace(/^\s*--.*$/gm, '').replaceAll('\n', ' '));
    }
    store = createD1Store(db); reopen = () => { store = createD1Store(db); };
    rows = async <T>(sql: string, ...values: (string | number | null)[]) => (await db.prepare(sql).bind(...values).all<T>()).results;
  }
  const installation = await store.activate(manifest, 'fixture-revision', null);
  await store.insert({ id: 'instance', pluginId: manifest.id, name: 'Fixture', config: {}, epoch: 1 }, null, installation);
  const captured = (await store.capture('instance'))!;
  const stamp: SourceStamp = { id: captured.id, pluginId: captured.pluginId, epoch: captured.epoch,
    pluginRevision: captured.pluginRevision, pluginGeneration: captured.pluginGeneration };
  return { get store() { return store; }, stamp, reopen, rows };
}

for (const adapter of ['SQLite', 'D1'] as const) {
  test(`${adapter}: paged entries resume without partial publication, duplicate identities or cyclic cursors`, async () => {
    const fixture = await setup(adapter); const { stamp, rows } = fixture;
    const old: Snapshot = { stamp, id: 'old', kind: 'directory', completedAt: date, statistics: { exported: 1 }, items: [file('old')] };
    await rows('INSERT INTO directory_snapshots (instance_id, kind, ref, request_id, document) VALUES (?, ?, ?, ?, ?)',
      stamp.id, key.kind, key.ref, 'legacy', JSON.stringify(old));
    expect(await fixture.store.snapshotHeader(stamp.id, key)).toEqual({ stamp, id: old.id, kind: old.kind, completedAt: old.completedAt, statistics: old.statistics! });
    expect(await fixture.store.snapshotHeader(stamp.id, { kind: 'directory', ref: 'absent' })).toBeNull();
    const created = await fixture.store.createRefresh(record(stamp, 'paged'), true);
    const claimed = (await fixture.store.claimRefresh(created.operationId, 'first', now, now + 100))!;
    expect(claimed).toMatchObject({ status: 'running', revision: 1, leaseToken: 'first', leaseUntil: now + 100 });
    const items = Array.from({ length: 120 }, (_, index) => file(`entry-${index}`));
    const checkpoint = next(claimed, { task: { ...claimed.task!, pages: 1, entries: items.length, cursor: 'second' } });
    expect(await fixture.store.commitRefresh(claimed, checkpoint, { items, nextCursor: 'second' })).toBe('committed');
    expect((await fixture.store.snapshot(stamp.id, key))?.value).toEqual(old);
    expect(await fixture.store.commitRefresh(claimed, checkpoint, { items, nextCursor: 'second' })).toBe('stale');
    fixture.reopen();
    expect(await fixture.store.refreshRecord('paged')).toEqual(checkpoint);
    expect(await fixture.store.currentRefresh(stamp.id)).toEqual(checkpoint);
    const second = (await fixture.store.claimRefresh('paged', 'second', now + 1, now + 101))!;
    const completed = next(second, { status: 'completed', task: null, refreshedDirectories: 1 });
    expect(await fixture.store.commitRefresh(second, completed, { items: [items[0]!], publish: header(second, 'new') })).toBe('duplicate_entry');
    expect(await fixture.store.commitRefresh(second, completed, { items: [file('last')], nextCursor: 'second' })).toBe('cyclic_cursor');
    expect(await fixture.store.refreshRecord('paged')).toEqual(second);
    expect((await rows<{ count: number }>('SELECT count(*) AS count FROM library_snapshot_entries'))[0]!.count).toBe(120);
    expect(await fixture.store.commitRefresh(second, completed, { items: [file('last')], publish: header(second, 'new') })).toBe('committed');
    expect((await fixture.store.snapshot(stamp.id, key))?.value).toEqual({ ...header(second, 'new'), kind: 'directory', items: [...items, file('last')] });
    expect(await fixture.store.snapshotHeader(stamp.id, key)).toEqual(header(second, 'new'));
    const persisted = (await rows<{ document: string; published_attempt_id: string }>('SELECT document, published_attempt_id FROM directory_snapshots'))[0]!;
    expect(JSON.parse(persisted.document)).not.toHaveProperty('items'); expect(persisted.published_attempt_id).toBe('paged-attempt');
    expect((await rows<{ count: number }>('SELECT count(*) AS count FROM library_refresh_cursors'))[0]!.count).toBe(0);
    expect(await fixture.store.readyRefreshes(now + 1000, 10)).toEqual([]);
  });

  test(`${adapter}: replacement, lease takeover, cancellation and source changes fence stale writes`, async () => {
    const fixture = await setup(adapter); const { stamp } = fixture;
    const first = await fixture.store.createRefresh(record(stamp, 'first'), false);
    expect((await fixture.store.createRefresh(record(stamp, 'ordinary-miss'), false)).operationId).toBe(first.operationId);
    expect(await fixture.store.readyRefreshes(now, 10)).toEqual(['first']);
    const oldLease = (await fixture.store.claimRefresh('first', 'old', now, now + 100))!;
    expect(await fixture.store.claimRefresh('first', 'busy', now + 50, now + 150)).toBeNull();
    expect(await fixture.store.readyRefreshes(now + 99, 10)).toEqual([]);
    expect(await fixture.store.readyRefreshes(now + 100, 10)).toEqual(['first']);
    const newLease = (await fixture.store.claimRefresh('first', 'new', now + 100, now + 200))!;
    expect(await fixture.store.commitRefresh(oldLease, next(oldLease), { items: [file('late')] })).toBe('stale');
    await fixture.store.createRefresh(record(stamp, 'replacement'), true);
    expect(await fixture.store.refreshRecord('first')).toMatchObject({ status: 'superseded', leaseToken: null, revision: newLease.revision + 1 });
    expect(await fixture.store.commitRefresh(newLease, next(newLease), { items: [file('superseded')] })).toBe('stale');
    const cancelled = (await fixture.store.claimRefresh('replacement', 'cancelled', now, now + 100))!;
    await fixture.store.cancelRefresh('replacement', date);
    expect(await fixture.store.refreshRecord('replacement')).toMatchObject({ status: 'cancelled', revision: cancelled.revision + 1, leaseToken: null });
    expect(await fixture.store.commitRefresh(cancelled, next(cancelled), { items: [file('cancelled')] })).toBe('stale');
    await fixture.store.createRefresh(record(stamp, 'config-old'), true);
    const configLease = (await fixture.store.claimRefresh('config-old', 'config', now, now + 100))!;
    const source = (await fixture.store.capture(stamp.id))!; expect(await fixture.store.configure(source, { changed: true }, null)).toBe(true);
    expect(await fixture.store.commitRefresh(configLease, next(configLease), { items: [file('config-stale')], publish: header(configLease, 'stale') })).toBe('stale');
    expect(await fixture.store.claimRefresh('config-old', 'invalid', now + 1000, now + 2000)).toBeNull();
    expect(await fixture.store.readyRefreshes(now + 1000, 10)).toEqual([]);
    await fixture.store.cancelRefresh('config-old', date);
    expect((await fixture.store.refreshRecord('config-old'))?.status).toBe('running');
    await expect(Promise.resolve().then(() => fixture.store.createRefresh(record(stamp, 'invalid-source'), true))).rejects.toMatchObject({ code: 'stale_call' });
    const changed = { ...stamp, epoch: stamp.epoch + 1 };
    await fixture.store.createRefresh(record(changed, 'config-new'), false);
    expect((await fixture.store.refreshRecord('config-old'))?.status).toBe('superseded');
    const pluginLease = (await fixture.store.claimRefresh('config-new', 'plugin', now, now + 100))!;
    await fixture.store.markMissing(manifest.id, stamp.pluginGeneration);
    expect(await fixture.store.commitRefresh(pluginLease, next(pluginLease), { items: [file('removed')] })).toBe('stale');
    expect(await fixture.store.readyRefreshes(now + 1000, 10)).toEqual([]);
    expect((await fixture.rows<{ count: number }>('SELECT count(*) AS count FROM library_snapshot_entries'))[0]!.count).toBe(0);
  });

  test(`${adapter}: directory transitions begin the next attempt and failures reclaim only unpublished candidates`, async () => {
    const fixture = await setup(adapter); const { stamp, rows } = fixture;
    const old: Snapshot = { stamp, id: 'old', kind: 'directory', completedAt: date, items: [file('old')] };
    await rows('INSERT INTO directory_snapshots (instance_id, kind, ref, request_id, document) VALUES (?, ?, ?, ?, ?)',
      stamp.id, key.kind, key.ref, 'old', JSON.stringify(old));
    await fixture.store.createRefresh(record(stamp, 'instance-job', { kind: 'roots', ref: '' }), true);
    const roots = (await fixture.store.claimRefresh('instance-job', 'roots', now, now + 100))!;
    const directory = next(roots, { task: { key, attemptId: 'directory-attempt', pages: 0, entries: 0, children: [] }, refreshedDirectories: 1 });
    const root = { sourceId: 'root', name: 'Root', directoryRef: key.ref };
    expect(await fixture.store.commitRefresh(roots, directory, { items: [root], publish: header(roots, 'roots') })).toBe('committed');
    expect((await fixture.store.snapshot(stamp.id, { kind: 'roots', ref: '' }))?.value?.items).toEqual([root]);
    expect((await rows<{ request_id: string }>("SELECT request_id FROM directory_snapshots WHERE kind = 'directory'"))[0]!.request_id).toBe('directory-attempt');
    const partial = (await fixture.store.claimRefresh('instance-job', 'partial', now, now + 100))!;
    const continued = next(partial, { task: { ...partial.task!, pages: 1, entries: 1, cursor: 'next' } });
    await fixture.store.commitRefresh(partial, continued, { items: [file('candidate')], nextCursor: 'next' });
    const failing = (await fixture.store.claimRefresh('instance-job', 'fail', now, now + 100))!;
    expect(await fixture.store.commitRefresh(failing, next(failing, { status: 'failed', task: null }), undefined, 'temporary')).toBe('committed');
    expect(await fixture.store.snapshot(stamp.id, key)).toEqual({ value: old, error: 'temporary' });
    expect((await rows<{ identity: string }>('SELECT identity FROM library_snapshot_entries'))).toEqual([{ identity: 'root' }]);
    await fixture.store.createRefresh(record(stamp, 'later'), true); await fixture.store.cancelRefresh('later', date);
    expect((await fixture.store.snapshot(stamp.id, { kind: 'roots', ref: '' }))?.value?.items).toEqual([root]);
  });
}
