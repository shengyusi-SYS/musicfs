import type { RefreshSchedule } from '../../core/library/schedules';
import type { SnapshotKey } from '../../core/library/types';
import type { SqlStatement } from './refresh-sql';

export type RefreshScheduleRow = { instance_id: string; kind: SnapshotKey['kind']; ref: string; interval_minutes: number; next_run_at: number };
export const scheduleFromRow = (row: RefreshScheduleRow | null | undefined): RefreshSchedule | null => row ? {
  instanceId: row.instance_id, key: { kind: row.kind, ref: row.ref }, intervalMinutes: row.interval_minutes, nextRunAt: row.next_run_at
} : null;
const eligible = `FROM refresh_schedules s JOIN instances i ON i.id = s.instance_id
  JOIN installations p ON p.id = i.plugin_id AND p.status = 'active'
  WHERE NOT EXISTS (SELECT 1 FROM library_refresh_jobs r WHERE r.instance_id = s.instance_id
    AND r.status IN ('queued', 'running') AND r.source_epoch = i.epoch AND r.plugin_revision = p.revision
    AND r.plugin_generation = p.generation)`;
export const refreshScheduleSQL = 'SELECT * FROM refresh_schedules WHERE instance_id = ? AND kind = ? AND ref = ?';
export const nextRefreshScheduleSQL = `SELECT MIN(s.next_run_at) AS instant ${eligible}`;
export function saveRefreshScheduleStatement(instanceId: string, key: SnapshotKey, intervalMinutes: number, nextRunAt: number): SqlStatement {
  return intervalMinutes === 0
    ? { sql: 'DELETE FROM refresh_schedules WHERE instance_id = ? AND kind = ? AND ref = ?', values: [instanceId, key.kind, key.ref] }
    : { sql: `INSERT INTO refresh_schedules (instance_id, kind, ref, interval_minutes, next_run_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(instance_id, kind, ref) DO UPDATE SET interval_minutes = excluded.interval_minutes, next_run_at = excluded.next_run_at`,
      values: [instanceId, key.kind, key.ref, intervalMinutes, nextRunAt] };
}
export function claimDueRefreshScheduleStatement(now: number): SqlStatement {
  return { sql: `UPDATE refresh_schedules SET next_run_at = ? + interval_minutes * 60000
    WHERE rowid = (SELECT s.rowid ${eligible} AND s.next_run_at <= ? ORDER BY s.next_run_at, s.rowid LIMIT 1)
    RETURNING *`, values: [now, now] };
}
