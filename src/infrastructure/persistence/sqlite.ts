import { Database } from 'bun:sqlite';
import type { Json, PluginManifest } from '@musicfs/plugin-api';
import { ExtensionError, type Installation, type InstallationStore } from '../../core/extensions';
import type { AuthenticationRecord, Instance, InstanceStore, SourceStamp } from '../../core/sources';
import initialSchema from './migrations/0001.sql' with { type: 'text' };
import librarySchema from './migrations/0002.sql' with { type: 'text' };
import authenticationSchema from './migrations/0003.sql' with { type: 'text' };
import type { LayoutNode, LibraryStore, Snapshot } from '../../core/library/types';

type InstallationRow = { manifest: string; revision: string; generation: number; status: 'active' | 'missing' };
type InstanceRow = { id: string; plugin_id: string; name: string; config: string; epoch: number };
type SnapshotRow = InstanceRow & { private_state: string; state_revision: number; revision: string; generation: number; authentication: string | null };
const instanceFromRow = (row: InstanceRow): Instance => ({
  id: row.id, pluginId: row.plugin_id, name: row.name, config: JSON.parse(row.config) as Json, epoch: row.epoch
});

/** SQLite owns each compare-and-write, including the active installation predicate. */
export function openSqlite(path: string) {
  const db = new Database(path, { create: true, strict: true });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version;
  if (version === undefined || version < 0 || version > 3) { db.close(); throw new Error('Unsupported MusicFS database version'); }
  if (version < 3) db.transaction(() => {
    if (version === 0) db.exec(initialSchema);
    if (version < 2) db.exec(librarySchema);
    db.exec(authenticationSchema); db.exec('PRAGMA user_version = 3');
  })();

  const installation = (id: string): Installation | undefined => {
    const row = db.query<InstallationRow, [string]>('SELECT manifest, revision, generation, status FROM installations WHERE id = ?').get(id);
    return row ? { manifest: JSON.parse(row.manifest) as PluginManifest, revision: row.revision, generation: row.generation, status: row.status } : undefined;
  };
  const predicate = `id = $id AND epoch = $epoch AND EXISTS (
    SELECT 1 FROM installations p WHERE p.id = instances.plugin_id
    AND p.revision = $revision AND p.generation = $generation AND p.status = 'active')`;
  const bindings = (snapshot: SourceStamp) => ({
    id: snapshot.id, epoch: snapshot.epoch, revision: snapshot.pluginRevision, generation: snapshot.pluginGeneration
  });
  const currentSource = `EXISTS (SELECT 1 FROM instances i JOIN installations p ON p.id = i.plugin_id
    WHERE i.id = ? AND i.epoch = ? AND p.revision = ? AND p.generation = ? AND p.status = 'active')`;
  const sourceValues = (stamp: SourceStamp) => [stamp.id, stamp.epoch, stamp.pluginRevision, stamp.pluginGeneration];

  return {
    installation,
    installations: () => db.query<{ id: string }, []>('SELECT id FROM installations ORDER BY id').all().map(row => installation(row.id)!),
    activate: db.transaction((manifest: PluginManifest, revision: string, expectedGeneration: number | null) => {
      const previous = installation(manifest.id);
      if ((previous?.generation ?? null) !== expectedGeneration) throw new ExtensionError('revision_conflict', 'Installation changed');
      const next = { manifest, revision, generation: (previous?.generation ?? 0) + 1, status: 'active' as const };
      db.query(`INSERT INTO installations (id, manifest, revision, generation, status) VALUES (?, ?, ?, ?, 'active')
        ON CONFLICT(id) DO UPDATE SET manifest = excluded.manifest, revision = excluded.revision,
        generation = excluded.generation, status = excluded.status`).run(manifest.id, JSON.stringify(manifest), revision, next.generation);
      return next;
    }),
    markMissing(id, expectedGeneration) {
      const { changes } = db.query("UPDATE installations SET status = 'missing', generation = generation + 1 WHERE id = ? AND generation = ?").run(id, expectedGeneration);
      if (changes !== 1) throw new ExtensionError('revision_conflict', 'Installation changed');
    },
    instances: () => db.query<InstanceRow, []>('SELECT id, plugin_id, name, config, epoch FROM instances ORDER BY rowid').all().map(instanceFromRow),
    capture(id) {
      const row = db.query<SnapshotRow, [string]>(`SELECT i.*, p.revision, p.generation FROM instances i JOIN installations p
        ON p.id = i.plugin_id WHERE i.id = ? AND p.status = 'active'`).get(id);
      return row ? { ...instanceFromRow(row), privateState: JSON.parse(row.private_state) as Json, stateRevision: row.state_revision,
        pluginRevision: row.revision, pluginGeneration: row.generation, authentication: row.authentication === null ? null : JSON.parse(row.authentication) as AuthenticationRecord } : undefined;
    },
    insert(instance, state, current) {
      return db.query(`INSERT INTO instances (id, plugin_id, name, config, private_state, epoch, state_revision)
        SELECT ?, ?, ?, ?, ?, ?, 1 WHERE EXISTS (SELECT 1 FROM installations WHERE id = ? AND revision = ? AND generation = ? AND status = 'active')`)
        .run(instance.id, instance.pluginId, instance.name, JSON.stringify(instance.config), JSON.stringify(state), instance.epoch,
          instance.pluginId, current.revision, current.generation).changes === 1;
    },
    current: snapshot => db.query(`SELECT 1 FROM instances WHERE ${predicate}`).get(bindings(snapshot)) !== null,
    saveState(snapshot, state) {
      return db.query(`UPDATE instances SET private_state = $state, state_revision = state_revision + 1
        WHERE ${predicate} AND state_revision = $stateRevision`).run({ ...bindings(snapshot), state: JSON.stringify(state), stateRevision: snapshot.stateRevision }).changes === 1;
    },
    configure(snapshot, config, state) {
      return db.query(`UPDATE instances SET config = $config, private_state = $state, epoch = epoch + 1, state_revision = state_revision + 1, authentication = NULL
        WHERE ${predicate} AND state_revision = $stateRevision`).run({ ...bindings(snapshot), config: JSON.stringify(config), state: JSON.stringify(state), stateRevision: snapshot.stateRevision }).changes === 1;
    },
    advanceAuthentication(snapshot, next) {
      return db.query(`UPDATE instances SET authentication = $next, epoch = epoch + 1, state_revision = state_revision + 1
        WHERE ${predicate} AND authentication IS $expected`).run({ ...bindings(snapshot), next: JSON.stringify(next), expected: snapshot.authentication === null ? null : JSON.stringify(snapshot.authentication) }).changes === 1;
    },
    saveAuthentication(snapshot, next, state) {
      return db.query(`UPDATE instances SET authentication = $next, private_state = $state, epoch = $nextEpoch, state_revision = state_revision + 1
        WHERE ${predicate} AND state_revision = $stateRevision AND authentication IS $expected`).run({ ...bindings(snapshot), next: JSON.stringify(next), state: JSON.stringify(state), nextEpoch: next.stamp.epoch,
          stateRevision: snapshot.stateRevision, expected: snapshot.authentication === null ? null : JSON.stringify(snapshot.authentication) }).changes === 1;
    },
    deleteInstance: id => { db.query('DELETE FROM instances WHERE id = ?').run(id); },
    layout() {
      const row = db.query<{ revision: number; nodes: string | null }, []>('SELECT revision, nodes FROM library_layout WHERE id = 1').get();
      if (!row) throw new Error('Library layout migration is missing');
      return { revision: row.revision, nodes: row.nodes === null ? null : JSON.parse(row.nodes) as LayoutNode[] };
    },
    saveLayout(expectedRevision, nodes) {
      return db.query('UPDATE library_layout SET revision = revision + 1, nodes = ? WHERE id = 1 AND revision = ?')
        .run(nodes === null ? null : JSON.stringify(nodes), expectedRevision).changes === 1;
    },
    snapshot(instanceId, key) {
      const row = db.query<{ document: string | null; error: string | null }, [string, string, string]>(
        'SELECT document, error FROM directory_snapshots WHERE instance_id = ? AND kind = ? AND ref = ?').get(instanceId, key.kind, key.ref);
      return row ? { value: row.document === null ? null : JSON.parse(row.document) as Snapshot, error: row.error } : undefined;
    },
    knownDirectoryRefs(instanceId) {
      return db.query<{ ref: string }, [string]>("SELECT ref FROM directory_snapshots WHERE instance_id = ? AND kind = 'directory'")
        .all(instanceId).map(row => row.ref);
    },
    beginRefresh(stamp, key, requestId) {
      return db.query(`INSERT INTO directory_snapshots (instance_id, kind, ref, request_id) SELECT ?, ?, ?, ? WHERE ${currentSource}
        ON CONFLICT(instance_id, kind, ref) DO UPDATE SET request_id = excluded.request_id`)
        .run(stamp.id, key.kind, key.ref, requestId, ...sourceValues(stamp)).changes === 1;
    },
    publishSnapshot(stamp, key, requestId, value) {
      return db.query(`UPDATE directory_snapshots SET document = ?, error = NULL
        WHERE instance_id = ? AND kind = ? AND ref = ? AND request_id = ? AND ${currentSource}`)
        .run(JSON.stringify(value), stamp.id, key.kind, key.ref, requestId, ...sourceValues(stamp)).changes === 1;
    },
    failRefresh(stamp, key, requestId, error) {
      db.query(`UPDATE directory_snapshots SET error = ? WHERE instance_id = ? AND kind = ? AND ref = ? AND request_id = ? AND ${currentSource}`)
        .run(error, stamp.id, key.kind, key.ref, requestId, ...sourceValues(stamp));
    },
    close: () => db.close()
  } satisfies InstallationStore & InstanceStore & LibraryStore & { close(): void };
}
