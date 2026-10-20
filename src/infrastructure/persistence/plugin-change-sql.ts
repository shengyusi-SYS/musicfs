import type { ChangeLease, ChangeMutation, MigrationInput, PluginChangeRecord } from '../../application/change-plugin';
import type { SqlStatement, SqlValue } from './refresh-sql';

export type ChangeRow = { document: string; revision: number; lease_token: string };
export type ChangeInputRow = { instance_id: string; plugin_id: string; name: string; config: string; private_state: string; epoch: number; state_revision: number };
const statement = (sql: string, ...values: SqlValue[]): SqlStatement => ({ sql, values });
const active = "status NOT IN ('completed', 'failed')";
export const changeRecordSQL = 'SELECT document FROM plugin_changes WHERE operation_id = ?';
export const nextChangeInstanceSQL = `SELECT instance_id, plugin_id, name, config, private_state, epoch, state_revision
  FROM plugin_change_instances WHERE operation_id = ? AND candidate_config IS NULL ORDER BY instance_id LIMIT 1`;
export const readyChangesSQL = `SELECT operation_id FROM plugin_changes WHERE ${active}
  AND (lease_token IS NULL OR lease_until <= ?) ORDER BY rowid LIMIT ?`;

export function changeFromRow(row: { document: string } | null | undefined): PluginChangeRecord | null {
  return row ? JSON.parse(row.document) as PluginChangeRecord : null;
}
export function changeLeaseFromRow(row: ChangeRow | null | undefined): ChangeLease | null {
  return row ? { record: JSON.parse(row.document) as PluginChangeRecord, revision: row.revision, token: row.lease_token } : null;
}
export function changeInputFromRow(row: ChangeInputRow | null | undefined): MigrationInput | null {
  return row ? { id: row.instance_id, pluginId: row.plugin_id, name: row.name, config: JSON.parse(row.config),
    privateState: JSON.parse(row.private_state), epoch: row.epoch, stateRevision: row.state_revision } : null;
}
export function createChangeStatement(record: PluginChangeRecord): SqlStatement {
  return statement(`INSERT INTO plugin_changes (operation_id, status, document)
    SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM plugin_changes WHERE ${active})
    ON CONFLICT DO NOTHING RETURNING document`, record.view.operationId, record.view.status, JSON.stringify(record));
}
export function claimChangeStatement(operationId: string, token: string, now: number, until: number): SqlStatement {
  if (!token || until <= now) throw new Error('Invalid plugin change lease');
  return statement(`UPDATE plugin_changes SET revision = revision + 1, lease_token = ?, lease_until = ?, mutation_token = NULL
    WHERE operation_id = ? AND ${active} AND (lease_token IS NULL OR lease_until <= ?)
    RETURNING document, revision, lease_token`, token, until, operationId, now);
}
export function releaseChangeStatement(operationId: string, token: string): SqlStatement {
  return statement(`UPDATE plugin_changes SET lease_token = NULL, lease_until = 0, mutation_token = NULL
    WHERE operation_id = ? AND lease_token = ?`, operationId, token);
}

/** Every statement after the CAS is gated by a fresh marker, never by an old revision alone. */
export function commitChangePlan(expected: ChangeLease, next: PluginChangeRecord, mutation: ChangeMutation, now: number): SqlStatement[] {
  const before = expected.record;
  if (before.view.operationId !== next.view.operationId || before.view.pluginId !== next.view.pluginId || before.view.kind !== next.view.kind
    || before.revision !== next.revision || before.expectedGeneration !== next.expectedGeneration
    || JSON.stringify(before.manifest) !== JSON.stringify(next.manifest) || JSON.stringify(before.previousManifest) !== JSON.stringify(next.previousManifest)
    || before.manifest.id !== before.view.pluginId || (before.inputsCaptured && next.inputsCaptured !== true)
    || (mutation.kind === 'activate') !== (next.view.status === 'completed') || (mutation.kind === 'fail') !== (next.view.status === 'failed')) {
    throw new Error('Invalid plugin change checkpoint transition');
  }
  const operationId = before.view.operationId; const pluginId = before.view.pluginId;
  const conditions = [`operation_id = ?`, active, 'revision = ?', 'lease_token = ?', 'lease_token IS NOT NULL', 'lease_until > ?', 'document = ?'];
  const values: SqlValue[] = [operationId, expected.revision, expected.token, now, JSON.stringify(before)];
  let document = next;
  if (mutation.kind === 'capture') {
    conditions.push("COALESCE(json_extract(document, '$.inputsCaptured'), 0) = 0");
    document = { ...next, inputsCaptured: true };
  }
  if (mutation.kind === 'candidate') {
    conditions.push("json_extract(document, '$.inputsCaptured') = 1",
      'EXISTS (SELECT 1 FROM plugin_change_instances WHERE operation_id = ? AND instance_id = ? AND candidate_config IS NULL)');
    values.push(operationId, mutation.instanceId);
  }
  if (mutation.kind === 'activate') {
    let baseline: string;
    const baselineValues: SqlValue[] = [];
    if (before.expectedGeneration === null) {
      baseline = 'NOT EXISTS (SELECT 1 FROM installations WHERE id = ?)'; baselineValues.push(pluginId);
    } else {
      baseline = `EXISTS (SELECT 1 FROM installations WHERE id = ? AND generation = ?${before.previousManifest ? ' AND manifest = ?' : ''})`;
      baselineValues.push(pluginId, before.expectedGeneration);
      if (before.previousManifest) baselineValues.push(JSON.stringify(before.previousManifest));
    }
    if (!mutation.migrateInstances) {
      // Old Worker code could activate first and leave a verifying operation behind.
      // Recover only this exact target generation; never increment it a second time.
      baseline = `(${baseline} OR EXISTS (SELECT 1 FROM installations WHERE id = ? AND generation = ? AND revision = ? AND manifest = ? AND status = ?))`;
      baselineValues.push(pluginId, (before.expectedGeneration ?? 0) + 1, before.revision, JSON.stringify(before.manifest), before.view.kind === 'install' ? 'active' : 'missing');
    }
    conditions.push(baseline); values.push(...baselineValues);
    if (before.view.kind === 'remove' && before.expectedGeneration === null) conditions.push('0');
    if (mutation.migrateInstances) {
      conditions.push("json_extract(document, '$.inputsCaptured') = 1",
        'NOT EXISTS (SELECT 1 FROM plugin_change_instances WHERE operation_id = ? AND candidate_config IS NULL)',
        `NOT EXISTS (SELECT 1 FROM instances i WHERE i.plugin_id = ? AND NOT EXISTS (
          SELECT 1 FROM plugin_change_instances c WHERE c.operation_id = ? AND c.instance_id = i.id AND c.plugin_id = i.plugin_id
          AND c.epoch = i.epoch AND c.state_revision = i.state_revision))`,
        `NOT EXISTS (SELECT 1 FROM plugin_change_instances c WHERE c.operation_id = ? AND NOT EXISTS (
          SELECT 1 FROM instances i WHERE i.id = c.instance_id AND i.plugin_id = c.plugin_id AND i.plugin_id = ?
          AND i.epoch = c.epoch AND i.state_revision = c.state_revision))`);
      values.push(operationId, pluginId, operationId, operationId, pluginId);
    }
  }
  const token = crypto.randomUUID();
  const written = statement('SELECT 1 FROM plugin_changes WHERE operation_id = ? AND mutation_token = ?', operationId, token);
  const plan = [statement(`UPDATE plugin_changes SET status = ?, document = ?, revision = revision + 1, mutation_token = ?
    WHERE ${conditions.join(' AND ')}`, document.view.status, JSON.stringify(document), token, ...values)];
  if (mutation.kind === 'capture') {
    plan.push(statement(`INSERT INTO plugin_change_instances (operation_id, instance_id, plugin_id, name, config, private_state, epoch, state_revision)
      SELECT ?, id, plugin_id, name, config, private_state, epoch, state_revision FROM instances
      WHERE plugin_id = ? AND EXISTS (${written.sql})`, operationId, pluginId, ...written.values));
  } else if (mutation.kind === 'candidate') {
    plan.push(statement(`UPDATE plugin_change_instances SET candidate_config = ?, candidate_state = ?
      WHERE operation_id = ? AND instance_id = ? AND EXISTS (${written.sql})`,
    JSON.stringify(mutation.value.config), JSON.stringify(mutation.value.privateState), operationId, mutation.instanceId, ...written.values));
  } else if (mutation.kind === 'activate') {
    if (mutation.migrateInstances) plan.push(statement(`UPDATE instances SET
      config = (SELECT c.candidate_config FROM plugin_change_instances c WHERE c.operation_id = ? AND c.instance_id = instances.id),
      private_state = (SELECT c.candidate_state FROM plugin_change_instances c WHERE c.operation_id = ? AND c.instance_id = instances.id),
      epoch = epoch + 1, state_revision = state_revision + 1, authentication = NULL
      WHERE plugin_id = ? AND EXISTS (${written.sql})`, operationId, operationId, pluginId, ...written.values));
    if (before.view.kind === 'install') plan.push(statement(`INSERT INTO installations (id, manifest, revision, generation, status)
      SELECT ?, ?, ?, ?, 'active' WHERE EXISTS (${written.sql})
      ON CONFLICT(id) DO UPDATE SET manifest = excluded.manifest, revision = excluded.revision, generation = excluded.generation, status = excluded.status`,
    pluginId, JSON.stringify(before.manifest), before.revision, (before.expectedGeneration ?? 0) + 1, ...written.values));
    else plan.push(statement(`UPDATE installations SET status = 'missing', generation = ? WHERE id = ? AND EXISTS (${written.sql})`, (before.expectedGeneration ?? 0) + 1, pluginId, ...written.values));
  }
  if (mutation.kind === 'activate' || mutation.kind === 'fail') {
    plan.push(statement(`DELETE FROM plugin_change_instances WHERE operation_id = ? AND EXISTS (${written.sql})`, operationId, ...written.values));
    plan.push(statement(`DELETE FROM worker_plugin_change_files WHERE operation_id = ? AND EXISTS (${written.sql})`, operationId, ...written.values));
  }
  plan.push(statement(`SELECT document, revision, lease_token FROM plugin_changes WHERE operation_id = ? AND mutation_token = ?`, operationId, token));
  return plan;
}
