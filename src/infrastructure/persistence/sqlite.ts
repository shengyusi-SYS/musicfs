import { Database } from 'bun:sqlite';
import type { Json, PluginManifest } from '@musicfs/plugin-api';
import { ExtensionError, type Installation, type InstallationStore } from '../../core/extensions';
import type { AuthenticationRecord, Instance, InstanceStore, SourceStamp } from '../../core/sources';
import initialSchema from './migrations/0001.sql' with { type: 'text' };
import librarySchema from './migrations/0002.sql' with { type: 'text' };
import authenticationSchema from './migrations/0003.sql' with { type: 'text' };
import workerChangesSchema from './migrations/0004.sql' with { type: 'text' };
import refreshSchema from './migrations/0005.sql' with { type: 'text' };
import pluginChangesSchema from './migrations/0006.sql' with { type: 'text' };
import renewalsSchema from './migrations/0007.sql' with { type: 'text' };
import pluginCacheSchema from './migrations/0008.sql' with { type: 'text' };
import pluginCacheIndexes from './migrations/0009.sql' with { type: 'text' };
import refreshSchedulesSchema from './migrations/0010.sql' with { type: 'text' };
import type { RefreshScheduleStore } from '../../core/library/schedules';
import { refreshScheduleSQL, nextRefreshScheduleSQL, saveRefreshScheduleStatement, claimDueRefreshScheduleStatement,
  scheduleFromRow, type RefreshScheduleRow } from './refresh-schedule-sql';
import type { PluginCacheStore } from '../../core/sources/cache';
import { cachedPluginDataStatement, cachedPluginDataManyStatement, cachePluginDataPlan, cachePluginDataManyPlan, cachePluginDataIfAbsentPlan } from './plugin-cache-sql';
import type { RenewalStore } from '../../core/sources/renewal';
import { claimRenewalPlan, finishRenewalPlan, noActiveRenewalSQL, releaseRenewalStatement, renewalClaimFromRow, type RenewalClaimRow } from './renewal-sql';
import type { LayoutNode, LibraryStore } from '../../core/library/types';
import type { RefreshPage, RefreshRecord, RefreshStore } from '../../core/library/refresh-types';
import type { PluginChangeStore } from '../../application/change-plugin';
import { changeFromRow, changeLeaseFromRow, changeInputFromRow, changeRecordSQL, nextChangeInstanceSQL, readyChangesSQL,
  createChangeStatement, claimChangeStatement, releaseChangeStatement, commitChangePlan, type ChangeRow, type ChangeInputRow } from './plugin-change-sql';
import { cancelRefreshPlan, claimRefreshStatement, commitRefreshPlan, createdRefresh, createRefreshPlan, currentRefreshSQL,
  readyRefreshesSQL, refreshFromRow, refreshRecordSQL, snapshotEntriesSQL, snapshotFromRows, snapshotHeaderFromRow, snapshotHeaderSQL,
  type RefreshDocumentRow, type RefreshOutcome, type SnapshotEntryRow, type SnapshotHeaderRow, type SqlStatement, type SqlValue } from './refresh-sql';

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
  if (version === undefined || version < 0 || version > 10) { db.close(); throw new Error('Unsupported MusicFS database version'); }
  if (version < 10) db.transaction(() => {
    if (version === 0) db.exec(initialSchema);
    if (version < 2) db.exec(librarySchema);
    if (version < 3) db.exec(authenticationSchema);
    if (version < 4) db.exec(workerChangesSchema);
    if (version < 5) db.exec(refreshSchema);
    if (version < 6) db.exec(pluginChangesSchema);
    if (version < 7) db.exec(renewalsSchema);
    if (version < 8) db.exec(pluginCacheSchema);
    if (version < 9) db.exec(pluginCacheIndexes);
    db.exec(refreshSchedulesSchema); db.exec('PRAGMA user_version = 10');
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
  const execute = <T>(query: SqlStatement): T[] => db.query<T, SqlValue[]>(query.sql).all(...query.values);
  const batch = <T>(queries: SqlStatement[]): T[][] => db.transaction(() => queries.map(query => execute<T>(query)))();

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
        WHERE ${predicate} AND state_revision = $stateRevision AND ${noActiveRenewalSQL}`)
        .run({ ...bindings(snapshot), state: JSON.stringify(state), stateRevision: snapshot.stateRevision }).changes === 1;
    },
    configure(snapshot, config, state, preserveContent = false) {
      return db.query(`UPDATE instances SET config = $config, private_state = $state, epoch = epoch + $advance, state_revision = state_revision + 1,
        authentication = CASE WHEN $advance = 0 THEN authentication ELSE NULL END
        WHERE ${predicate} AND state_revision = $stateRevision`).run({ ...bindings(snapshot), config: JSON.stringify(config), state: JSON.stringify(state),
          advance: preserveContent ? 0 : 1, stateRevision: snapshot.stateRevision }).changes === 1;
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
    cachedPluginData(source, key, now) { return execute<{ document: string }>(cachedPluginDataStatement(source, key, now))[0]?.document; },
    cachedPluginDataMany(source, keys, now) { return execute<{ key: string; document: string }>(cachedPluginDataManyStatement(source, keys, now)); },
    cachePluginData(source, key, document, expiresAt, now, cleanup = true) {
      const plan = cachePluginDataPlan(source, key, document, expiresAt, now);
      return batch(cleanup ? plan : plan.slice(1)).at(-1)!.length === 1;
    },
    cachePluginDataMany(source, items, now, cleanup = true) {
      const plan = cachePluginDataManyPlan(source, items, now);
      return batch(cleanup ? plan : plan.slice(1)).at(-1)!.length === items.length;
    },
    cachePluginDataIfAbsent(source, key, document, now, cleanup = true) {
      const plan = cachePluginDataIfAbsentPlan(source, key, document, now);
      return batch<{ document: string }>(cleanup ? plan : plan.slice(1)).at(-1)?.[0]?.document;
    },
    claimRenewal(expected, token, now, until) {
      return renewalClaimFromRow(batch<RenewalClaimRow>(claimRenewalPlan(expected, token, now, until)).at(-1)?.[0]);
    },
    finishRenewal(expected, token, outcome, now, retryAt) {
      return batch(finishRenewalPlan(expected, token, outcome, now, retryAt)).at(-1)!.length === 1;
    },
    releaseRenewal(instanceId, token) { execute(releaseRenewalStatement(instanceId, token)); },
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
      return snapshotFromRows(db.query<SnapshotEntryRow, [string, string, string]>(snapshotEntriesSQL).all(instanceId, key.kind, key.ref));
    },
    snapshotHeader(instanceId, key) {
      return snapshotHeaderFromRow(db.query<SnapshotHeaderRow, [string, string, string]>(snapshotHeaderSQL).get(instanceId, key.kind, key.ref));
    },
    knownDirectoryRefs(instanceId) {
      return db.query<{ ref: string }, [string]>("SELECT ref FROM directory_snapshots WHERE instance_id = ? AND kind = 'directory'")
        .all(instanceId).map(row => row.ref);
    },
    createChange(record) { return execute(createChangeStatement(record)).length === 1; },
    changeRecord(operationId) { return changeFromRow(db.query<{ document: string }, [string]>(changeRecordSQL).get(operationId)); },
    claimChange(operationId, token, now, until) { return changeLeaseFromRow(execute<ChangeRow>(claimChangeStatement(operationId, token, now, until))[0]); },
    commitChange(expected, next, mutation, now) { return changeLeaseFromRow(batch<ChangeRow>(commitChangePlan(expected, next, mutation, now)).at(-1)?.[0]); },
    nextChangeInstance(operationId) { return changeInputFromRow(db.query<ChangeInputRow, [string]>(nextChangeInstanceSQL).get(operationId)); },
    releaseChange(operationId, token) { execute(releaseChangeStatement(operationId, token)); },
    readyChanges(now, limit) { return db.query<{ operation_id: string }, [number, number]>(readyChangesSQL).all(now, limit).map(row => row.operation_id); },
    createRefresh(record, replace) {
      const results = batch<RefreshDocumentRow>(createRefreshPlan(record, replace));
      return createdRefresh(results.at(-1)!);
    },
    refreshRecord(operationId) {
      return refreshFromRow(db.query<RefreshDocumentRow, [string]>(refreshRecordSQL).get(operationId));
    },
    currentRefresh(instanceId) {
      return refreshFromRow(db.query<RefreshDocumentRow, [string]>(currentRefreshSQL).get(instanceId));
    },
    claimRefresh(operationId, token, now, until) {
      return refreshFromRow(execute<RefreshDocumentRow>(claimRefreshStatement(operationId, token, now, until))[0]);
    },
    commitRefresh(expected, next, page, directoryError) {
      return batch<{ outcome: RefreshOutcome }>(commitRefreshPlan(expected, next, page, directoryError))[0]![0]!.outcome;
    },
    /** Compare inside SQLite, without loading either full directory into the desktop process. */
    publishedEntriesChanged(expected: RefreshRecord, page: RefreshPage) {
      const task = expected.task;
      if (!task || !page.publish) return true;
      const same = db.query<{ same: number }, SqlValue[]>(`WITH previous AS (
        SELECT published_attempt_id, document FROM directory_snapshots WHERE instance_id = ? AND kind = ? AND ref = ?
      ), candidate AS (
        SELECT ordinal, document FROM library_snapshot_entries WHERE attempt_id = ?
        UNION ALL SELECT CAST(key AS INTEGER) + ?, value FROM json_each(?)
      ) SELECT 1 AS same FROM previous p WHERE p.published_attempt_id IS NOT NULL
        AND json_extract(p.document, '$.stamp.id') = ? AND json_extract(p.document, '$.stamp.epoch') = ?
        AND json_extract(p.document, '$.stamp.pluginId') = ? AND json_extract(p.document, '$.stamp.pluginRevision') = ?
        AND json_extract(p.document, '$.stamp.pluginGeneration') = ?
        AND (SELECT COUNT(*) FROM library_snapshot_entries WHERE attempt_id = p.published_attempt_id) = ?
        AND NOT EXISTS (SELECT 1 FROM candidate c LEFT JOIN library_snapshot_entries e
          ON e.attempt_id = p.published_attempt_id AND e.ordinal = c.ordinal
          WHERE e.document IS NULL OR e.document <> c.document)`)
        .get(expected.stamp.id, task.key.kind, task.key.ref, task.attemptId, task.entries, JSON.stringify(page.items),
          expected.stamp.id, expected.stamp.epoch, expected.stamp.pluginId, expected.stamp.pluginRevision,
          expected.stamp.pluginGeneration, task.entries + page.items.length);
      return !same;
    },
    cancelRefresh(operationId, updatedAt) { batch(cancelRefreshPlan(operationId, updatedAt)); },
    readyRefreshes(now, limit) {
      return db.query<{ operation_id: string }, [number, number]>(readyRefreshesSQL).all(now, limit).map(row => row.operation_id);
    },
    refreshSchedule(instanceId, key) {
      return scheduleFromRow(db.query<RefreshScheduleRow, [string, string, string]>(refreshScheduleSQL).get(instanceId, key.kind, key.ref));
    },
    saveRefreshSchedule(instanceId, key, intervalMinutes, nextRunAt) { execute(saveRefreshScheduleStatement(instanceId, key, intervalMinutes, nextRunAt)); },
    claimDueRefreshSchedule(now) { return scheduleFromRow(execute<RefreshScheduleRow>(claimDueRefreshScheduleStatement(now))[0]); },
    nextRefreshScheduleAt() { return db.query<{ instant: number | null }, []>(nextRefreshScheduleSQL).get()?.instant ?? null; },
    nextBackgroundWorkAt() {
      // Reuse the ready predicates with an unbounded lease horizon, including
      // the refresh source fence. No timer is needed when only stale jobs remain.
      return db.query<{ instant: number | null }, [number, number, number, number]>(`SELECT MIN(instant) AS instant FROM (
        SELECT CASE WHEN lease_token IS NULL THEN 0 ELSE lease_until END AS instant FROM plugin_changes
          WHERE operation_id IN (${readyChangesSQL})
        UNION ALL SELECT MAX(CASE WHEN lease_token IS NULL THEN 0 ELSE lease_until END, COALESCE(json_extract(document, '$.retryAt'), 0)) FROM library_refresh_jobs
          WHERE operation_id IN (${readyRefreshesSQL}))`).get(Number.MAX_SAFE_INTEGER, -1, Number.MAX_SAFE_INTEGER, -1)?.instant ?? null;
    },
    close: () => db.close()
  } satisfies InstallationStore & InstanceStore & LibraryStore & RefreshStore & RefreshScheduleStore & PluginChangeStore & RenewalStore & PluginCacheStore & {
    close(): void; nextBackgroundWorkAt(): number | null; publishedEntriesChanged(expected: RefreshRecord, page: RefreshPage): boolean;
  };
}
