import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Log, LogLevel, Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { PluginManifest } from '@musicfs/plugin-api';
import type { InstallationStore } from '../src/core/extensions';
import type { InstanceStore } from '../src/core/sources';
import { nextInstallation, type ChangeLease, type PluginChangeRecord, type PluginChangeStore } from '../src/application/change-plugin';
import { createD1Store } from '../src/infrastructure/persistence/d1';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';

type Store = InstallationStore & InstanceStore & PluginChangeStore;
type Adapter = 'SQLite' | 'D1';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const now = 10_000; const date = new Date(now).toISOString();
const oldManifest: PluginManifest = { formatVersion: 1, id: 'org.musicfs.migration-fixture', name: 'Migration fixture', version: '1.0.0', apiRange: '^0.1.3',
  hosts: { desktop: 'index.mjs', worker: 'index.mjs' }, configVersion: 1, stateVersion: 1, files: ['index.mjs'] };
const targetManifest: PluginManifest = { ...oldManifest, version: '2.0.0', configVersion: 2, stateVersion: 2 };
function record(id = 'change'): PluginChangeRecord {
  return { view: { operationId: id, pluginId: oldManifest.id, kind: 'install', status: 'queued', createdAt: date, updatedAt: date },
    expectedGeneration: 1, previousManifest: oldManifest, manifest: targetManifest, revision: 'target-revision',
    codeReady: true, registry: 'retained-registry', attemptedAt: now };
}
function completed(lease: ChangeLease): PluginChangeRecord {
  return { ...lease.record, view: { ...lease.record.view, status: 'completed', installation: nextInstallation(lease.record) } };
}
function present<T>(value: T | null | undefined): T { if (value == null) throw new Error('Expected persistence result'); return value; }

async function setup(adapter: Adapter, instances = 2, installed = true) {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-plugin-change-'));
  let store: Store; let reopen: () => Promise<void>;
  let rows: <T>(sql: string, ...values: (string | number | null)[]) => Promise<T[]>;
  if (adapter === 'SQLite') {
    const path = join(directory, 'state.sqlite'); let current = openSqlite(path); store = current;
    const inspect = new Database(path);
    rows = async <T>(sql: string, ...values: (string | number | null)[]) => inspect.query<T, (string | number | null)[]>(sql).all(...values);
    reopen = async () => { current.close(); current = openSqlite(path); store = current; };
    cleanups.push(async () => { current.close(); inspect.close(); await rm(directory, { recursive: true, force: true }); });
  } else {
    const options = { modules: true, script: 'export default {fetch(){return new Response("Plugin change fixture")}}', compatibilityDate: '2026-07-30',
      d1Databases: { DB: 'plugin-change-tests' }, d1Persist: directory, log: new Log(LogLevel.ERROR) };
    let mf = new Miniflare(options); let db = await mf.getD1Database('DB') as unknown as D1Database;
    cleanups.push(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
    for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()).replace(/^\s*--.*$/gm, '').replaceAll('\n', ' '));
    }
    store = createD1Store(db);
    rows = async <T>(sql: string, ...values: (string | number | null)[]) => (await db.prepare(sql).bind(...values).all<T>()).results;
    reopen = async () => { await mf.dispose(); mf = new Miniflare(options); db = await mf.getD1Database('DB') as unknown as D1Database; store = createD1Store(db); };
  }
  if (installed) {
    const installation = await store.activate(oldManifest, 'old-revision', null);
    for (let index = 0; index < instances; index++) {
      const id = String.fromCharCode(97 + index);
      await store.insert({ id, pluginId: oldManifest.id, name: `Instance ${id}`, config: { legacy: id }, epoch: 1 }, { session: id }, installation);
    }
    await rows('UPDATE instances SET authentication = ?', JSON.stringify({ operationId: 'old-authentication' }));
  }
  return { get store() { return store; }, rows, reopen,
    async active() { return { installation: await store.installation(oldManifest.id), instances: await rows('SELECT * FROM instances ORDER BY id') }; },
    async claim(document = record()) {
      expect(await store.createChange(document)).toBe(true);
      return present(await store.claimChange(document.view.operationId, 'holder', now, now + 1000));
    },
    async capture(lease: ChangeLease) { return present(await store.commitChange(lease, { ...lease.record, inputsCaptured: true }, { kind: 'capture' }, now + 1)); },
    async prepareAll(lease: ChangeLease) {
      for (;;) {
        const instance = await store.nextChangeInstance(lease.record.view.operationId); if (!instance) return lease;
        lease = present(await store.commitChange(lease, lease.record,
          { kind: 'candidate', instanceId: instance.id, value: { config: { migrated: instance.config }, privateState: { restored: instance.privateState } } }, now + 2));
      }
    }
  };
}

for (const adapter of ['SQLite', 'D1'] as const) {
  test(`${adapter}: two frozen candidates survive restart and activate with installation in one transaction`, async () => {
    const f = await setup(adapter); const before = await f.active(); let lease = await f.claim();
    expect(await f.store.createChange(record('competing'))).toBe(false);
    lease = await f.capture(lease);
    expect(await f.store.nextChangeInstance('change')).toEqual({ id: 'a', pluginId: oldManifest.id, name: 'Instance a', config: { legacy: 'a' }, privateState: { session: 'a' }, epoch: 1, stateRevision: 1 });
    lease = present(await f.store.commitChange(lease, lease.record,
      { kind: 'candidate', instanceId: 'a', value: { config: { new: 'a' }, privateState: { newSession: 'a' } } }, now + 2));
    expect(await f.active()).toEqual(before);
    expect(await f.store.commitChange(lease, completed(lease), { kind: 'activate', migrateInstances: true }, now + 3)).toBeNull();
    expect(await f.active()).toEqual(before);
    await f.reopen();
    expect(await f.store.changeRecord('change')).toEqual(lease.record);
    expect((await f.store.nextChangeInstance('change'))?.id).toBe('b');
    lease = await f.prepareAll(lease);
    await f.rows("INSERT INTO worker_plugin_change_files (operation_id, name, chunk_index, bytes) VALUES ('change', 'fixture.mjs', 0, X'01')");
    const done = present(await f.store.commitChange(lease, completed(lease), { kind: 'activate', migrateInstances: true }, now + 4));
    expect(done.record.view.status).toBe('completed'); expect(done.record.registry).toBe('retained-registry'); expect(done.record.attemptedAt).toBe(now);
    expect(await f.store.installation(oldManifest.id)).toEqual(nextInstallation(lease.record));
    const a = present(await f.store.capture('a')); const b = present(await f.store.capture('b'));
    expect(a).toMatchObject({ config: { new: 'a' }, privateState: { newSession: 'a' }, epoch: 2, stateRevision: 2, authentication: null, pluginGeneration: 2 });
    expect(b).toMatchObject({ config: { migrated: { legacy: 'b' } }, privateState: { restored: { session: 'b' } }, epoch: 2, stateRevision: 2, authentication: null, pluginGeneration: 2 });
    expect(await f.rows('SELECT * FROM plugin_change_instances')).toEqual([]); expect(await f.rows('SELECT * FROM worker_plugin_change_files')).toEqual([]);
    expect(await f.store.commitChange(lease, completed(lease), { kind: 'activate', migrateInstances: true }, now + 5)).toBeNull();
    expect((await f.store.installation(oldManifest.id))?.generation).toBe(2);
    expect(await f.store.readyChanges(now + 5000, 10)).toEqual([]);
  }, 20_000);

  test(`${adapter}: failed candidate preparation clears only staged inputs/code and preserves the active installation`, async () => {
    const f = await setup(adapter); const before = await f.active(); let lease = await f.capture(await f.claim());
    lease = present(await f.store.commitChange(lease, lease.record, { kind: 'candidate', instanceId: 'a', value: { config: null, privateState: null } }, now + 2));
    expect((await f.store.nextChangeInstance('change'))?.id).toBe('b'); // JSON null is a ready value, not SQL NULL.
    await f.rows("INSERT INTO worker_plugin_change_files (operation_id, name, chunk_index, bytes) VALUES ('change', 'fixture.mjs', 0, X'01')");
    const failed = present(await f.store.commitChange(lease, { ...lease.record, view: { ...lease.record.view, status: 'failed', error: { code: 'migration_failed', message: 'Fixture rejection' } } }, { kind: 'fail' }, now + 3));
    expect(failed.record.view.status).toBe('failed'); expect(await f.active()).toEqual(before);
    expect(await f.rows('SELECT * FROM plugin_change_instances')).toEqual([]); expect(await f.rows('SELECT * FROM worker_plugin_change_files')).toEqual([]);
    expect(await f.store.claimChange('change', 'late', now + 2000, now + 3000)).toBeNull();
    expect(await f.store.createChange(record('retry'))).toBe(true);
  }, 20_000);

  test(`${adapter}: state CAS, epochs, added/deleted instances and installation generations reject the entire activation`, async () => {
    for (const conflict of ['state', 'epoch', 'added', 'deleted', 'generation'] as const) {
      const f = await setup(adapter); let lease = await f.capture(await f.claim()); lease = await f.prepareAll(lease);
      if (conflict === 'state') expect(await f.store.saveState(present(await f.store.capture('a')), { changed: true })).toBe(true);
      if (conflict === 'epoch') expect(await f.store.configure(present(await f.store.capture('a')), { changed: true }, null)).toBe(true);
      if (conflict === 'added') expect(await f.store.insert({ id: 'added', pluginId: oldManifest.id, name: 'Late', config: {}, epoch: 1 }, null, present(await f.store.installation(oldManifest.id)))).toBe(true);
      if (conflict === 'deleted') await f.store.deleteInstance('b');
      if (conflict === 'generation') await f.store.activate(oldManifest, 'another-revision', 1);
      const changed = await f.active(); const oldOperation = await f.store.changeRecord('change');
      expect(await f.store.commitChange(lease, completed(lease), { kind: 'activate', migrateInstances: true }, now + 4)).toBeNull();
      expect(await f.active()).toEqual(changed); expect(await f.store.changeRecord('change')).toEqual(oldOperation);
      expect((await f.rows('SELECT * FROM plugin_change_instances')).length).toBe(2);
    }
  }, 30_000);

  test(`${adapter}: zero-instance capture is durable and cannot select a later baseline`, async () => {
    const f = await setup(adapter, 0); const lease = await f.capture(await f.claim());
    expect(lease.record.inputsCaptured).toBe(true); expect(await f.store.nextChangeInstance('change')).toBeNull();
    await f.reopen();
    expect((await f.store.changeRecord('change'))?.inputsCaptured).toBe(true);
    expect(await f.store.insert({ id: 'late', pluginId: oldManifest.id, name: 'Late', config: {}, epoch: 1 }, null, present(await f.store.installation(oldManifest.id)))).toBe(true);
    expect(await f.store.commitChange(lease, lease.record, { kind: 'capture' }, now + 2)).toBeNull();
    expect(await f.store.nextChangeInstance('change')).toBeNull();
    expect(await f.store.commitChange(lease, completed(lease), { kind: 'activate', migrateInstances: true }, now + 3)).toBeNull();
    expect((await f.store.installation(oldManifest.id))?.generation).toBe(1);
    expect((await f.store.capture('late'))?.stateRevision).toBe(1);
  }, 20_000);

  test(`${adapter}: expired leases and old tokens cannot checkpoint, release or activate new work`, async () => {
    const f = await setup(adapter); const old = await f.claim();
    expect(await f.store.readyChanges(now + 999, 10)).toEqual([]);
    expect(await f.store.commitChange(old, old.record, { kind: 'checkpoint' }, now + 1000)).toBeNull();
    expect(await f.store.readyChanges(now + 1000, 10)).toEqual(['change']);
    const fresh = present(await f.store.claimChange('change', 'fresh-token', now + 1000, now + 2000));
    expect(fresh.revision).toBe(old.revision + 1);
    await f.store.releaseChange('change', old.token);
    expect(await f.store.readyChanges(now + 1001, 10)).toEqual([]);
    expect(await f.store.commitChange(old, old.record, { kind: 'capture' }, now + 1001)).toBeNull();
    expect(await f.store.commitChange(old, completed(old), { kind: 'activate', migrateInstances: false }, now + 1001)).toBeNull();
    expect(await f.rows('SELECT * FROM plugin_change_instances')).toEqual([]);
    const checkpoint = present(await f.store.commitChange(fresh, { ...fresh.record, registry: 'new-checkpoint' }, { kind: 'checkpoint' }, now + 1001));
    expect(checkpoint.revision).toBe(fresh.revision + 1); expect(checkpoint.record.registry).toBe('new-checkpoint');
    expect(await f.store.commitChange(fresh, fresh.record, { kind: 'checkpoint' }, now + 1002)).toBeNull();
    await f.store.releaseChange('change', checkpoint.token); expect(await f.store.readyChanges(now + 1003, 10)).toEqual(['change']);
  }, 20_000);

  test(`${adapter}: first install/remove and legacy verifying completion do not migrate or increment a target twice`, async () => {
    const f = await setup(adapter, 0, false); const first = record('first'); first.expectedGeneration = null; delete first.previousManifest;
    let lease = await f.claim(first);
    expect(await f.store.commitChange(lease, completed(lease), { kind: 'activate', migrateInstances: false }, now + 1)).not.toBeNull();
    expect((await f.store.installation(oldManifest.id))?.generation).toBe(1);
    const legacy = record('legacy'); legacy.expectedGeneration = null; delete legacy.previousManifest; legacy.view.status = 'verifying';
    lease = await f.claim(legacy);
    expect(await f.store.commitChange(lease, completed(lease), { kind: 'activate', migrateInstances: false }, now + 1)).not.toBeNull();
    expect((await f.store.installation(oldManifest.id))?.generation).toBe(1);
    const removal = record('remove'); removal.view.kind = 'remove'; removal.manifest = targetManifest; removal.previousManifest = targetManifest;
    lease = await f.claim(removal);
    expect(await f.store.commitChange(lease, completed(lease), { kind: 'activate', migrateInstances: false }, now + 1)).not.toBeNull();
    expect(await f.store.installation(oldManifest.id)).toMatchObject({ status: 'missing', generation: 2, revision: 'target-revision' });
    const oldRemoval = { ...removal, view: { ...removal.view, operationId: 'legacy-remove', status: 'verifying' as const } };
    lease = await f.claim(oldRemoval);
    expect(await f.store.commitChange(lease, completed(lease), { kind: 'activate', migrateInstances: false }, now + 1)).not.toBeNull();
    expect((await f.store.installation(oldManifest.id))?.generation).toBe(2);
  }, 20_000);
}
