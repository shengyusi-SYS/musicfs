import type { D1Database } from '@cloudflare/workers-types';
import type { Json, PluginManifest } from '@musicfs/plugin-api';
import { ExtensionError, type Installation, type InstallationStore } from '../../core/extensions';
import type { AuthenticationRecord, Instance, InstanceStore, SourceStamp } from '../../core/sources';
import type { LayoutNode, LibraryStore, Snapshot } from '../../core/library/types';

type InstallationRow = { manifest: string; revision: string; generation: number; status: 'active' | 'missing' };
type InstanceRow = { id: string; plugin_id: string; name: string; config: string; epoch: number };
type SnapshotRow = InstanceRow & { private_state: string; state_revision: number; revision: string; generation: number; authentication: string | null };
const instanceFromRow = (row: InstanceRow): Instance => ({
  id: row.id, pluginId: row.plugin_id, name: row.name, config: JSON.parse(row.config) as Json, epoch: row.epoch
});

/** Every write is one D1 statement with its own current-state predicate. */
export function createD1Store(db: D1Database) {
  const installation = async (id: string): Promise<Installation | undefined> => {
    const row = await db.prepare('SELECT manifest, revision, generation, status FROM installations WHERE id = ?').bind(id).first<InstallationRow>();
    return row ? { manifest: JSON.parse(row.manifest) as PluginManifest, revision: row.revision, generation: row.generation, status: row.status } : undefined;
  };
  const predicate = `id = ? AND epoch = ? AND EXISTS (
    SELECT 1 FROM installations p WHERE p.id = instances.plugin_id
    AND p.revision = ? AND p.generation = ? AND p.status = 'active')`;
  const bindings = (snapshot: SourceStamp) => [snapshot.id, snapshot.epoch, snapshot.pluginRevision, snapshot.pluginGeneration];
  const currentSource = `EXISTS (SELECT 1 FROM instances i JOIN installations p ON p.id = i.plugin_id
    WHERE i.id = ? AND i.epoch = ? AND p.revision = ? AND p.generation = ? AND p.status = 'active')`;
  return {
    installation,
    async installations() {
      const rows = await db.prepare('SELECT manifest, revision, generation, status FROM installations ORDER BY id').all<InstallationRow>();
      return rows.results.map(row => ({ manifest: JSON.parse(row.manifest) as PluginManifest, revision: row.revision, generation: row.generation, status: row.status }));
    },
    async activate(manifest: PluginManifest, revision: string, expectedGeneration: number | null): Promise<Installation> {
      const result = expectedGeneration === null
        ? await db.prepare(`INSERT INTO installations (id, manifest, revision, generation, status)
            VALUES (?, ?, ?, 1, 'active') ON CONFLICT(id) DO NOTHING`).bind(manifest.id, JSON.stringify(manifest), revision).run()
        : await db.prepare(`UPDATE installations SET manifest = ?, revision = ?, generation = generation + 1,
            status = 'active' WHERE id = ? AND generation = ?`).bind(JSON.stringify(manifest), revision, manifest.id, expectedGeneration).run();
      if (result.meta.changes !== 1) throw new ExtensionError('revision_conflict', 'Installation changed');
      return { manifest, revision, generation: (expectedGeneration ?? 0) + 1, status: 'active' };
    },
    async markMissing(id, expectedGeneration) {
      const result = await db.prepare("UPDATE installations SET status = 'missing', generation = generation + 1 WHERE id = ? AND generation = ?")
        .bind(id, expectedGeneration).run();
      if (result.meta.changes !== 1) throw new ExtensionError('revision_conflict', 'Installation changed');
    },
    async instances() {
      const rows = await db.prepare('SELECT id, plugin_id, name, config, epoch FROM instances ORDER BY rowid').all<InstanceRow>();
      return rows.results.map(instanceFromRow);
    },
    async capture(id) {
      const row = await db.prepare(`SELECT i.*, p.revision, p.generation FROM instances i JOIN installations p
        ON p.id = i.plugin_id WHERE i.id = ? AND p.status = 'active'`).bind(id).first<SnapshotRow>();
      return row ? { ...instanceFromRow(row), privateState: JSON.parse(row.private_state) as Json, stateRevision: row.state_revision,
        pluginRevision: row.revision, pluginGeneration: row.generation, authentication: row.authentication === null ? null : JSON.parse(row.authentication) as AuthenticationRecord } : undefined;
    },
    async insert(instance, state, current) {
      const result = await db.prepare(`INSERT INTO instances (id, plugin_id, name, config, private_state, epoch, state_revision)
        SELECT ?, ?, ?, ?, ?, ?, 1 WHERE EXISTS (SELECT 1 FROM installations WHERE id = ? AND revision = ? AND generation = ? AND status = 'active')`)
        .bind(instance.id, instance.pluginId, instance.name, JSON.stringify(instance.config), JSON.stringify(state), instance.epoch,
          instance.pluginId, current.revision, current.generation).run();
      return result.meta.changes === 1;
    },
    async current(snapshot) {
      return await db.prepare(`SELECT 1 FROM instances WHERE ${predicate}`).bind(...bindings(snapshot)).first() !== null;
    },
    async saveState(snapshot, state) {
      const result = await db.prepare(`UPDATE instances SET private_state = ?, state_revision = state_revision + 1
        WHERE ${predicate} AND state_revision = ?`).bind(JSON.stringify(state), ...bindings(snapshot), snapshot.stateRevision).run();
      return result.meta.changes === 1;
    },
    async configure(snapshot, config, state) {
      const result = await db.prepare(`UPDATE instances SET config = ?, private_state = ?, epoch = epoch + 1, state_revision = state_revision + 1, authentication = NULL
        WHERE ${predicate} AND state_revision = ?`).bind(JSON.stringify(config), JSON.stringify(state), ...bindings(snapshot), snapshot.stateRevision).run();
      return result.meta.changes === 1;
    },
    async advanceAuthentication(snapshot, next) {
      const result = await db.prepare(`UPDATE instances SET authentication = ?, epoch = epoch + 1, state_revision = state_revision + 1
        WHERE ${predicate} AND authentication IS ?`).bind(JSON.stringify(next), ...bindings(snapshot), snapshot.authentication === null ? null : JSON.stringify(snapshot.authentication)).run();
      return result.meta.changes === 1;
    },
    async saveAuthentication(snapshot, next, state) {
      const result = await db.prepare(`UPDATE instances SET authentication = ?, private_state = ?, epoch = ?, state_revision = state_revision + 1
        WHERE ${predicate} AND state_revision = ? AND authentication IS ?`).bind(JSON.stringify(next), JSON.stringify(state), next.stamp.epoch, ...bindings(snapshot),
          snapshot.stateRevision, snapshot.authentication === null ? null : JSON.stringify(snapshot.authentication)).run();
      return result.meta.changes === 1;
    },
    async deleteInstance(id) { await db.prepare('DELETE FROM instances WHERE id = ?').bind(id).run(); },
    async layout() {
      const row = await db.prepare('SELECT revision, nodes FROM library_layout WHERE id = 1').first<{ revision: number; nodes: string | null }>();
      if (!row) throw new Error('Library layout migration is missing');
      return { revision: row.revision, nodes: row.nodes === null ? null : JSON.parse(row.nodes) as LayoutNode[] };
    },
    async saveLayout(expectedRevision, nodes) {
      const result = await db.prepare('UPDATE library_layout SET revision = revision + 1, nodes = ? WHERE id = 1 AND revision = ?')
        .bind(nodes === null ? null : JSON.stringify(nodes), expectedRevision).run();
      return result.meta.changes === 1;
    },
    async snapshot(instanceId, key) {
      const row = await db.prepare('SELECT document, error FROM directory_snapshots WHERE instance_id = ? AND kind = ? AND ref = ?')
        .bind(instanceId, key.kind, key.ref).first<{ document: string | null; error: string | null }>();
      return row ? { value: row.document === null ? null : JSON.parse(row.document) as Snapshot, error: row.error } : undefined;
    },
    async knownDirectoryRefs(instanceId) {
      const rows = await db.prepare("SELECT ref FROM directory_snapshots WHERE instance_id = ? AND kind = 'directory'")
        .bind(instanceId).all<{ ref: string }>();
      return rows.results.map(row => row.ref);
    },
    async beginRefresh(stamp, key, requestId) {
      const result = await db.prepare(`INSERT INTO directory_snapshots (instance_id, kind, ref, request_id) SELECT ?, ?, ?, ? WHERE ${currentSource}
        ON CONFLICT(instance_id, kind, ref) DO UPDATE SET request_id = excluded.request_id`)
        .bind(stamp.id, key.kind, key.ref, requestId, ...bindings(stamp)).run();
      return result.meta.changes === 1;
    },
    async publishSnapshot(stamp, key, requestId, value) {
      const result = await db.prepare(`UPDATE directory_snapshots SET document = ?, error = NULL
        WHERE instance_id = ? AND kind = ? AND ref = ? AND request_id = ? AND ${currentSource}`)
        .bind(JSON.stringify(value), stamp.id, key.kind, key.ref, requestId, ...bindings(stamp)).run();
      return result.meta.changes === 1;
    },
    async failRefresh(stamp, key, requestId, error) {
      await db.prepare(`UPDATE directory_snapshots SET error = ? WHERE instance_id = ? AND kind = ? AND ref = ? AND request_id = ? AND ${currentSource}`)
        .bind(error, stamp.id, key.kind, key.ref, requestId, ...bindings(stamp)).run();
    }
  } satisfies InstallationStore & InstanceStore & LibraryStore;
}
