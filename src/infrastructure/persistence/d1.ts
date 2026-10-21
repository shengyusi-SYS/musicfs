import type { D1Database } from '@cloudflare/workers-types';
import type { Json, PluginManifest } from '@musicfs/plugin-api';
import { ExtensionError, type Installation, type InstallationStore } from '../../core/extensions';
import type { AuthenticationRecord, Instance, InstanceStore, SourceStamp } from '../../core/sources';
import type { LayoutNode, LibraryStore } from '../../core/library/types';
import type { RefreshStore } from '../../core/library/refresh-types';
import type { PluginChangeStore } from '../../application/change-plugin';
import type { RenewalStore } from '../../core/sources/renewal';
import type { PluginCacheStore } from '../../core/sources/cache';
import { cachedPluginDataStatement, cachedPluginDataManyStatement, cachePluginDataPlan, cachePluginDataManyPlan, cachePluginDataIfAbsentPlan } from './plugin-cache-sql';
import { claimRenewalPlan, finishRenewalPlan, noActiveRenewalSQL, releaseRenewalStatement, renewalClaimFromRow, type RenewalClaimRow } from './renewal-sql';
import { changeFromRow, changeLeaseFromRow, changeInputFromRow, changeRecordSQL, nextChangeInstanceSQL, readyChangesSQL,
  createChangeStatement, claimChangeStatement, releaseChangeStatement, commitChangePlan, type ChangeRow, type ChangeInputRow } from './plugin-change-sql';
import { cancelRefreshPlan, claimRefreshStatement, commitRefreshPlan, createdRefresh, createRefreshPlan, currentRefreshSQL,
  readyRefreshesSQL, refreshFromRow, refreshRecordSQL, snapshotEntriesSQL, snapshotFromRows, snapshotHeaderFromRow, snapshotHeaderSQL,
  type RefreshDocumentRow, type RefreshOutcome, type SnapshotEntryRow, type SnapshotHeaderRow, type SqlStatement } from './refresh-sql';

type InstallationRow = { manifest: string; revision: string; generation: number; status: 'active' | 'missing' };
type InstanceRow = { id: string; plugin_id: string; name: string; config: string; epoch: number };
type SnapshotRow = InstanceRow & { private_state: string; state_revision: number; revision: string; generation: number; authentication: string | null };
const instanceFromRow = (row: InstanceRow): Instance => ({
  id: row.id, pluginId: row.plugin_id, name: row.name, config: JSON.parse(row.config) as Json, epoch: row.epoch
});

/** Compare-and-writes use guarded statements; page commits run as an atomic D1 batch. */
export function createD1Store(db: D1Database) {
  const prepare = (query: SqlStatement) => db.prepare(query.sql).bind(...query.values);
  const installation = async (id: string): Promise<Installation | undefined> => {
    const row = await db.prepare('SELECT manifest, revision, generation, status FROM installations WHERE id = ?').bind(id).first<InstallationRow>();
    return row ? { manifest: JSON.parse(row.manifest) as PluginManifest, revision: row.revision, generation: row.generation, status: row.status } : undefined;
  };
  const predicate = `id = ? AND epoch = ? AND EXISTS (
    SELECT 1 FROM installations p WHERE p.id = instances.plugin_id
    AND p.revision = ? AND p.generation = ? AND p.status = 'active')`;
  const bindings = (snapshot: SourceStamp) => [snapshot.id, snapshot.epoch, snapshot.pluginRevision, snapshot.pluginGeneration];
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
        WHERE ${predicate} AND state_revision = ? AND ${noActiveRenewalSQL}`).bind(JSON.stringify(state), ...bindings(snapshot), snapshot.stateRevision).run();
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
    async cachedPluginData(source, key, now) {
      return (await prepare(cachedPluginDataStatement(source, key, now)).first<{ document: string }>())?.document;
    },
    async cachedPluginDataMany(source, keys, now) {
      return (await prepare(cachedPluginDataManyStatement(source, keys, now)).all<{ key: string; document: string }>()).results;
    },
    async cachePluginData(source, key, document, expiresAt, now, cleanup = true) {
      const plan = cachePluginDataPlan(source, key, document, expiresAt, now);
      const result = await db.batch<{ written: number }>((cleanup ? plan : plan.slice(1)).map(prepare));
      return result.at(-1)!.results.length === 1;
    },
    async cachePluginDataMany(source, items, now, cleanup = true) {
      const plan = cachePluginDataManyPlan(source, items, now);
      const result = await db.batch<{ written: number }>((cleanup ? plan : plan.slice(1)).map(prepare));
      return result.at(-1)!.results.length === items.length;
    },
    async cachePluginDataIfAbsent(source, key, document, now, cleanup = true) {
      const plan = cachePluginDataIfAbsentPlan(source, key, document, now);
      const result = await db.batch<{ document: string }>((cleanup ? plan : plan.slice(1)).map(prepare));
      return result.at(-1)?.results[0]?.document;
    },
    async claimRenewal(expected, token, now, until) {
      const results = await db.batch<RenewalClaimRow>(claimRenewalPlan(expected, token, now, until).map(prepare));
      return renewalClaimFromRow(results.at(-1)?.results[0]);
    },
    async finishRenewal(expected, token, outcome, now, retryAt) {
      const results = await db.batch(finishRenewalPlan(expected, token, outcome, now, retryAt).map(prepare));
      return results.at(-1)!.results.length === 1;
    },
    async releaseRenewal(instanceId, token) { await prepare(releaseRenewalStatement(instanceId, token)).run(); },
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
      const rows = await db.prepare(snapshotEntriesSQL).bind(instanceId, key.kind, key.ref).all<SnapshotEntryRow>();
      return snapshotFromRows(rows.results);
    },
    async snapshotHeader(instanceId, key) {
      return snapshotHeaderFromRow(await db.prepare(snapshotHeaderSQL).bind(instanceId, key.kind, key.ref).first<SnapshotHeaderRow>());
    },
    async knownDirectoryRefs(instanceId) {
      const rows = await db.prepare("SELECT ref FROM directory_snapshots WHERE instance_id = ? AND kind = 'directory'")
        .bind(instanceId).all<{ ref: string }>();
      return rows.results.map(row => row.ref);
    },
    async createChange(record) { return await prepare(createChangeStatement(record)).first() !== null; },
    async changeRecord(operationId) { return changeFromRow(await db.prepare(changeRecordSQL).bind(operationId).first<{ document: string }>()); },
    async claimChange(operationId, token, now, until) { return changeLeaseFromRow(await prepare(claimChangeStatement(operationId, token, now, until)).first<ChangeRow>()); },
    async commitChange(expected, next, mutation, now) {
      const results = await db.batch<ChangeRow>(commitChangePlan(expected, next, mutation, now).map(prepare));
      return changeLeaseFromRow(results.at(-1)?.results[0]);
    },
    async nextChangeInstance(operationId) { return changeInputFromRow(await db.prepare(nextChangeInstanceSQL).bind(operationId).first<ChangeInputRow>()); },
    async releaseChange(operationId, token) { await prepare(releaseChangeStatement(operationId, token)).run(); },
    async readyChanges(now, limit) { const rows = await db.prepare(readyChangesSQL).bind(now, limit).all<{ operation_id: string }>(); return rows.results.map(row => row.operation_id); },
    async createRefresh(record, replace) {
      const results = await db.batch<RefreshDocumentRow>(createRefreshPlan(record, replace).map(prepare));
      return createdRefresh(results.at(-1)!.results);
    },
    async refreshRecord(operationId) {
      return refreshFromRow(await db.prepare(refreshRecordSQL).bind(operationId).first<RefreshDocumentRow>());
    },
    async currentRefresh(instanceId) {
      return refreshFromRow(await db.prepare(currentRefreshSQL).bind(instanceId).first<RefreshDocumentRow>());
    },
    async claimRefresh(operationId, token, now, until) {
      return refreshFromRow(await prepare(claimRefreshStatement(operationId, token, now, until)).first<RefreshDocumentRow>());
    },
    async commitRefresh(expected, next, page, directoryError) {
      const results = await db.batch<{ outcome: RefreshOutcome }>(commitRefreshPlan(expected, next, page, directoryError).map(prepare));
      return results[0]!.results[0]!.outcome;
    },
    async cancelRefresh(operationId, updatedAt) { await db.batch(cancelRefreshPlan(operationId, updatedAt).map(prepare)); },
    async readyRefreshes(now, limit) {
      const rows = await db.prepare(readyRefreshesSQL).bind(now, limit).all<{ operation_id: string }>();
      return rows.results.map(row => row.operation_id);
    }
  } satisfies InstallationStore & InstanceStore & LibraryStore & RefreshStore & PluginChangeStore & RenewalStore & PluginCacheStore;
}
