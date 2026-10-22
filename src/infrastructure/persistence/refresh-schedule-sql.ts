import type { RefreshSchedule } from '../../core/library/schedules';
import type { UpdateRuleInput } from '../../contracts/refresh-policy';
import { updateScopeCoveredSQL, type SqlStatement } from './refresh-sql';

export type RefreshScheduleRow = { id: string; instance_id: string; target: string; timing: string; label: string | null;
  enabled: number; revision: number; next_run_at: number | null; operation_id: string | null; last_run_at: number | null; settled: number };
export const scheduleFromRow = (row: RefreshScheduleRow | null | undefined): RefreshSchedule | null => row ? {
  id: row.id, instanceId: row.instance_id, target: JSON.parse(row.target) as UpdateRuleInput['target'],
  timing: JSON.parse(row.timing) as UpdateRuleInput['timing'], label: row.label, enabled: row.enabled === 1,
  revision: row.revision, nextRunAt: row.next_run_at, operationId: row.operation_id, lastRunAt: row.last_run_at, settled: row.settled === 1
} : null;

const activeCurrent = `r.instance_id = s.instance_id AND r.status IN ('queued', 'running')
  AND r.source_epoch = i.epoch AND r.plugin_revision = p.revision AND r.plugin_generation = p.generation`;
const eligible = `FROM automatic_update_rules s JOIN instances i ON i.id = s.instance_id
  JOIN installations p ON p.id = i.plugin_id AND p.status = 'active'
  WHERE s.enabled = 1 AND s.next_run_at IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM library_refresh_jobs r WHERE ${activeCurrent}) OR
    EXISTS (SELECT 1 FROM library_refresh_jobs r WHERE ${activeCurrent} AND ${updateScopeCoveredSQL()}))`;
export const updateRuleSQL = 'SELECT * FROM automatic_update_rules WHERE id = ?';
export const updateRulesSQL = 'SELECT * FROM automatic_update_rules ORDER BY rowid';
export const completedUpdateRulesSQL = `SELECT s.* FROM automatic_update_rules s
  LEFT JOIN library_refresh_jobs r ON r.operation_id = s.operation_id
  LEFT JOIN instances i ON i.id = s.instance_id LEFT JOIN installations p ON p.id = i.plugin_id
  WHERE s.settled = 0 AND (r.operation_id IS NULL OR r.status NOT IN ('queued', 'running')
    OR p.id IS NULL OR p.status != 'active' OR r.source_epoch != i.epoch
    OR r.plugin_revision != p.revision OR r.plugin_generation != p.generation)`;
export const nextRefreshScheduleSQL = `SELECT MIN(s.next_run_at) AS instant ${eligible}`;
export const dueUpdateRuleSQL = `SELECT s.* ${eligible} AND s.next_run_at <= ? ORDER BY s.next_run_at, s.rowid LIMIT 1`;
export function saveUpdateRuleStatement(rule: RefreshSchedule): SqlStatement {
  return { sql: `INSERT INTO automatic_update_rules
    (id, instance_id, target, timing, label, enabled, revision, next_run_at, operation_id, last_run_at, settled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET instance_id = excluded.instance_id, target = excluded.target, timing = excluded.timing,
      label = excluded.label, enabled = excluded.enabled, revision = automatic_update_rules.revision + 1,
      next_run_at = excluded.next_run_at, operation_id = excluded.operation_id, last_run_at = excluded.last_run_at, settled = excluded.settled
    RETURNING *`, values: [rule.id, rule.instanceId, JSON.stringify(rule.target), JSON.stringify(rule.timing), rule.label,
    rule.enabled ? 1 : 0, rule.revision, rule.nextRunAt, rule.operationId, rule.lastRunAt, rule.settled ? 1 : 0] };
}
export function finishUpdateRuleStatement(rule: RefreshSchedule, nextRunAt: number | null): SqlStatement {
  return { sql: `UPDATE automatic_update_rules SET next_run_at = ?, settled = 1
    WHERE id = ? AND revision = ? AND operation_id = ? AND settled = 0`, values: [nextRunAt, rule.id, rule.revision, rule.operationId] };
}
