import { SourceError } from '../../core/sources';
import type { SourceStamp } from '../../core/sources';
import type { Snapshot } from '../../core/library/types';
import type { RefreshPage, RefreshRecord } from '../../core/library/refresh-types';

export type SqlValue = string | number | null;
export type SqlStatement = { sql: string; values: SqlValue[] };
export type RefreshDocumentRow = { document: string };
export type RefreshOutcome = 'committed' | 'stale' | 'duplicate_entry' | 'cyclic_cursor';
export type SnapshotEntryRow = { document: string | null; error: string | null; published_attempt_id: string | null; entry: string | null };
export type SnapshotHeaderRow = { stamp: string; id: string; kind: Snapshot['kind']; completed_at: string; statistics: string | null; error: string | null };
const statement = (sql: string, ...values: SqlValue[]): SqlStatement => ({ sql, values });
const active = "status IN ('queued', 'running')";
const current = `EXISTS (SELECT 1 FROM instances i JOIN installations p ON p.id = i.plugin_id
  WHERE i.id = r.instance_id AND i.plugin_id = r.plugin_id AND i.epoch = r.source_epoch
  AND p.revision = r.plugin_revision AND p.generation = r.plugin_generation AND p.status = 'active')`;
const currentStamp = `EXISTS (SELECT 1 FROM instances i JOIN installations p ON p.id = i.plugin_id
  WHERE i.id = ? AND i.plugin_id = ? AND i.epoch = ? AND p.revision = ? AND p.generation = ? AND p.status = 'active')`;
const stampValues = (stamp: SourceStamp): SqlValue[] => [stamp.id, stamp.pluginId, stamp.epoch, stamp.pluginRevision, stamp.pluginGeneration];

export const refreshRecordSQL = 'SELECT document FROM library_refresh_jobs WHERE operation_id = ?';
export const currentRefreshSQL = 'SELECT document FROM library_refresh_jobs WHERE instance_id = ? ORDER BY rowid DESC LIMIT 1';
export const readyRefreshesSQL = `SELECT operation_id FROM library_refresh_jobs r WHERE ${active} AND ${current}
  AND MAX(CASE WHEN lease_token IS NULL THEN 0 ELSE lease_until END, COALESCE(json_extract(document, '$.retryAt'), 0)) <= ? ORDER BY rowid LIMIT ?`;
// The reader uses only the first header. Avoid repeating it for every entry in a D1 result.
export const snapshotEntriesSQL = `SELECT CASE WHEN e.ordinal = 0 OR e.ordinal IS NULL THEN s.document END AS document,
  s.error, s.published_attempt_id, e.document AS entry
  FROM directory_snapshots s LEFT JOIN library_snapshot_entries e ON e.attempt_id = s.published_attempt_id
  WHERE s.instance_id = ? AND s.kind = ? AND s.ref = ? ORDER BY e.ordinal`;
export const snapshotHeaderSQL = `SELECT json_extract(document, '$.stamp') AS stamp, json_extract(document, '$.id') AS id,
  json_extract(document, '$.kind') AS kind, json_extract(document, '$.completedAt') AS completed_at,
  json_extract(document, '$.statistics') AS statistics, error FROM directory_snapshots
  WHERE instance_id = ? AND kind = ? AND ref = ? AND document IS NOT NULL`;

export function snapshotHeaderFromRow(row: SnapshotHeaderRow | null | undefined): (Omit<Snapshot, 'items'> & { error: string | null }) | null {
  return row ? { stamp: JSON.parse(row.stamp) as SourceStamp, id: row.id, kind: row.kind, completedAt: row.completed_at,
    ...(row.statistics === null ? {} : { statistics: JSON.parse(row.statistics) as Record<string, number> }), error: row.error } : null;
}

export function refreshFromRow(row: RefreshDocumentRow | null | undefined): RefreshRecord | null {
  return row ? JSON.parse(row.document) as RefreshRecord : null;
}

export function createdRefresh(rows: RefreshDocumentRow[]): RefreshRecord {
  const record = refreshFromRow(rows[0]);
  if (!record) throw new SourceError('stale_call', 'Source changed before refresh creation');
  return record;
}

export function snapshotFromRows(rows: SnapshotEntryRow[]): { value: Snapshot | null; error: string | null } | undefined {
  const row = rows[0];
  if (!row) return undefined;
  if (row.document === null) return { value: null, error: row.error };
  const document = JSON.parse(row.document) as Snapshot;
  return { value: row.published_attempt_id === null ? document
    : { ...document, items: rows.flatMap(item => item.entry === null ? [] : [JSON.parse(item.entry)]) } as Snapshot, error: row.error };
}

/** Only an instance's unreferenced candidates are reclaimed. Published entries outlive their jobs. */
function cleanup(instanceId: string, guard: SqlStatement): SqlStatement[] {
  return [
    statement(`DELETE FROM library_snapshot_entries WHERE instance_id = ? AND EXISTS (${guard.sql})
      AND NOT EXISTS (SELECT 1 FROM directory_snapshots s WHERE s.instance_id = ? AND s.published_attempt_id = library_snapshot_entries.attempt_id)
      AND NOT EXISTS (SELECT 1 FROM library_refresh_jobs j WHERE j.instance_id = ? AND j.${active}
        AND json_extract(j.document, '$.task.attemptId') = library_snapshot_entries.attempt_id)`,
    instanceId, ...guard.values, instanceId, instanceId),
    statement(`DELETE FROM library_refresh_cursors WHERE instance_id = ? AND EXISTS (${guard.sql})
      AND NOT EXISTS (SELECT 1 FROM library_refresh_jobs j WHERE j.instance_id = ? AND j.${active}
        AND json_extract(j.document, '$.task.attemptId') = library_refresh_cursors.attempt_id)`,
    instanceId, ...guard.values, instanceId)
  ];
}

function beginTask(record: RefreshRecord, guard: SqlStatement): SqlStatement | null {
  const task = record.task;
  if (!task) return null;
  return statement(`INSERT INTO directory_snapshots (instance_id, kind, ref, request_id)
    SELECT ?, ?, ?, ? WHERE EXISTS (${guard.sql})
    ON CONFLICT(instance_id, kind, ref) DO UPDATE SET request_id = excluded.request_id`,
  record.stamp.id, task.key.kind, task.key.ref, task.attemptId, ...guard.values);
}

export function createRefreshPlan(record: RefreshRecord, replace: boolean): SqlStatement[] {
  const values = stampValues(record.stamp);
  const own = statement(`SELECT 1 FROM library_refresh_jobs r WHERE operation_id = ? AND ${active}
    AND revision = ? AND document = ? AND ${current}`, record.operationId, record.revision, JSON.stringify(record));
  const plan = [
    statement(`UPDATE library_refresh_jobs AS r SET status = 'superseded', revision = revision + 1,
      lease_token = NULL, lease_until = NULL, mutation_token = NULL,
      document = json_set(document, '$.status', 'superseded', '$.revision', revision + 1,
        '$.leaseToken', NULL, '$.leaseUntil', NULL, '$.updatedAt', ?)
      WHERE instance_id = ? AND ${active} AND (? = 1 OR NOT ${current}) AND ${currentStamp}`,
    record.updatedAt, record.stamp.id, replace ? 1 : 0, ...values),
    statement(`INSERT INTO library_refresh_jobs (operation_id, instance_id, plugin_id, source_epoch, plugin_revision,
      plugin_generation, status, revision, lease_token, lease_until, document)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${currentStamp}
      AND NOT EXISTS (SELECT 1 FROM library_refresh_jobs WHERE instance_id = ? AND ${active})
      ON CONFLICT(operation_id) DO NOTHING`,
    record.operationId, ...values, record.status, record.revision, record.leaseToken, record.leaseUntil, JSON.stringify(record), ...values, record.stamp.id)
  ];
  const begin = beginTask(record, own); if (begin) plan.push(begin);
  plan.push(...cleanup(record.stamp.id, own));
  plan.push(statement(`SELECT document FROM library_refresh_jobs WHERE operation_id = ?
    UNION ALL SELECT document FROM library_refresh_jobs r WHERE instance_id = ? AND ${active}
      AND ${current} AND operation_id != ? LIMIT 1`, record.operationId, record.stamp.id, record.operationId));
  return plan;
}

export function claimRefreshStatement(operationId: string, token: string, now: number, until: number): SqlStatement {
  return statement(`UPDATE library_refresh_jobs AS r SET status = 'running', revision = revision + 1,
    lease_token = ?, lease_until = ?, mutation_token = NULL,
    document = json_set(document, '$.status', 'running', '$.revision', revision + 1,
      '$.leaseToken', ?, '$.leaseUntil', ?, '$.updatedAt', ?)
    WHERE operation_id = ? AND ${active} AND ${current}
      AND MAX(CASE WHEN lease_token IS NULL THEN 0 ELSE lease_until END, COALESCE(json_extract(document, '$.retryAt'), 0)) <= ?
    RETURNING document`, token, until, token, until, new Date(now).toISOString(), operationId, now);
}

export function commitRefreshPlan(expected: RefreshRecord, next: RefreshRecord, page?: RefreshPage, directoryError?: string): SqlStatement[] {
  if (expected.operationId !== next.operationId || next.revision !== expected.revision + 1 ||
    JSON.stringify(stampValues(expected.stamp)) !== JSON.stringify(stampValues(next.stamp))) throw new Error('Invalid refresh checkpoint transition');
  const task = expected.task;
  const items = JSON.stringify(page?.items ?? []);
  const identity = task?.key.kind === 'roots' ? '$.sourceId' : '$.entryId';
  const guard = statement(`SELECT 1 FROM library_refresh_jobs r WHERE operation_id = ? AND status = ?
    AND status = 'running' AND revision = ? AND lease_token = ? AND lease_token IS NOT NULL AND ${current}
    AND instance_id = ? AND plugin_id = ? AND source_epoch = ? AND plugin_revision = ? AND plugin_generation = ?
    AND json_extract(document, '$.task.attemptId') IS ?`, expected.operationId, expected.status, expected.revision,
  expected.leaseToken, ...stampValues(expected.stamp), task?.attemptId ?? null);
  const conditions: string[] = [`NOT EXISTS (${guard.sql})`]; const conditionValues = [...guard.values];
  if (page || directoryError !== undefined) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM directory_snapshots WHERE instance_id = ? AND kind = ? AND ref = ? AND request_id = ?)`);
    conditionValues.push(expected.stamp.id, task?.key.kind ?? '', task?.key.ref ?? '', task?.attemptId ?? '');
  }
  const stale = conditions.join(' OR ');
  const duplicate = page ? `EXISTS (SELECT 1 FROM json_each(?) p JOIN library_snapshot_entries e
    ON e.attempt_id = ? AND e.identity = json_extract(p.value, ?))
    OR EXISTS (SELECT 1 FROM json_each(?) p GROUP BY json_extract(p.value, ?) HAVING count(*) > 1)` : '0';
  const duplicateValues: SqlValue[] = page ? [items, task?.attemptId ?? '', identity, items, identity] : [];
  const cyclic = page?.nextCursor !== undefined ? 'EXISTS (SELECT 1 FROM library_refresh_cursors WHERE attempt_id = ? AND cursor = ?)' : '0';
  const cyclicValues: SqlValue[] = page?.nextCursor !== undefined ? [task?.attemptId ?? '', page.nextCursor] : [];
  const outcome = statement(`SELECT CASE WHEN ${stale} THEN 'stale' WHEN ${duplicate} THEN 'duplicate_entry'
    WHEN ${cyclic} THEN 'cyclic_cursor' ELSE 'committed' END AS outcome`, ...conditionValues, ...duplicateValues, ...cyclicValues);
  const mutation = crypto.randomUUID();
  // A fresh marker gates the rest of this atomic batch; old checkpoint replays must never append again.
  const written = statement(`SELECT 1 FROM library_refresh_jobs r WHERE operation_id = ? AND mutation_token = ? AND ${current}`,
    next.operationId, mutation);
  const plan = [outcome, statement(`UPDATE library_refresh_jobs SET status = ?, revision = ?, lease_token = ?, lease_until = ?,
    document = ?, mutation_token = ? WHERE operation_id = ? AND (${outcome.sql}) = 'committed'`,
  next.status, next.revision, next.leaseToken, next.leaseUntil, JSON.stringify(next), mutation, expected.operationId, ...outcome.values)];
  if (page && task) {
    plan.push(statement(`INSERT INTO library_snapshot_entries (instance_id, attempt_id, ordinal, identity, document)
      SELECT ?, ?, ? + CAST(p.key AS INTEGER), json_extract(p.value, ?), p.value FROM json_each(?) p WHERE EXISTS (${written.sql})`,
    expected.stamp.id, task.attemptId, task.entries, identity, items, ...written.values));
    if (page.nextCursor !== undefined) plan.push(statement(`INSERT INTO library_refresh_cursors (instance_id, attempt_id, cursor)
      SELECT ?, ?, ? WHERE EXISTS (${written.sql})`, expected.stamp.id, task.attemptId, page.nextCursor, ...written.values));
    if (page.publish) plan.push(statement(`UPDATE directory_snapshots SET document = ?, published_attempt_id = ?, error = NULL
      WHERE instance_id = ? AND kind = ? AND ref = ? AND request_id = ? AND EXISTS (${written.sql})`,
    JSON.stringify(page.publish), task.attemptId, expected.stamp.id, task.key.kind, task.key.ref, task.attemptId, ...written.values));
  }
  if (directoryError !== undefined && task) plan.push(statement(`UPDATE directory_snapshots SET error = ?
    WHERE instance_id = ? AND kind = ? AND ref = ? AND request_id = ? AND EXISTS (${written.sql})`,
  directoryError, expected.stamp.id, task.key.kind, task.key.ref, task.attemptId, ...written.values));
  if (next.task?.attemptId !== task?.attemptId) {
    const begin = beginTask(next, written); if (begin) plan.push(begin);
  }
  if (next.task?.attemptId !== task?.attemptId || !['queued', 'running'].includes(next.status)) plan.push(...cleanup(expected.stamp.id, written));
  return plan;
}

export function cancelRefreshPlan(operationId: string, updatedAt: string): SqlStatement[] {
  const mutation = crypto.randomUUID();
  const guard = statement(`SELECT 1 FROM library_refresh_jobs r WHERE operation_id = ? AND mutation_token = ? AND ${current}`, operationId, mutation);
  return [statement(`UPDATE library_refresh_jobs AS r SET status = 'cancelled', revision = revision + 1,
    lease_token = NULL, lease_until = NULL, mutation_token = ?,
    document = json_set(document, '$.status', 'cancelled', '$.revision', revision + 1,
      '$.leaseToken', NULL, '$.leaseUntil', NULL, '$.updatedAt', ?)
    WHERE operation_id = ? AND ${active} AND ${current}`, mutation, updatedAt, operationId),
  // The owning instance comes from the guarded row; a stale cancellation performs no cleanup.
  statement(`DELETE FROM library_snapshot_entries WHERE instance_id = (SELECT instance_id FROM library_refresh_jobs WHERE operation_id = ?)
    AND EXISTS (${guard.sql}) AND NOT EXISTS (SELECT 1 FROM directory_snapshots s WHERE s.instance_id = library_snapshot_entries.instance_id
      AND s.published_attempt_id = library_snapshot_entries.attempt_id)
    AND NOT EXISTS (SELECT 1 FROM library_refresh_jobs j WHERE j.instance_id = library_snapshot_entries.instance_id
      AND j.${active} AND json_extract(j.document, '$.task.attemptId') = library_snapshot_entries.attempt_id)`,
  operationId, ...guard.values),
  statement(`DELETE FROM library_refresh_cursors WHERE instance_id = (SELECT instance_id FROM library_refresh_jobs WHERE operation_id = ?)
    AND EXISTS (${guard.sql}) AND NOT EXISTS (SELECT 1 FROM library_refresh_jobs j WHERE j.instance_id = library_refresh_cursors.instance_id AND j.${active}
      AND json_extract(j.document, '$.task.attemptId') = library_refresh_cursors.attempt_id)`, operationId, ...guard.values)];
}
