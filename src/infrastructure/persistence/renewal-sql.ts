import type { Outcome, PluginFault } from '@musicfs/plugin-api';
import type { AuthenticationRecord, InstanceSnapshot } from '../../core/sources/types';
import type { RenewalClaim } from '../../core/sources/renewal';
import type { SqlStatement, SqlValue } from './refresh-sql';

type SnapshotRow = { id: string; plugin_id: string; name: string; config: string; private_state: string;
  epoch: number; state_revision: number; revision: string; generation: number; authentication: string | null };
export type RenewalClaimRow = SnapshotRow & { kind: RenewalClaim['kind']; lease_until: number | null; fault: string | null };
const statement = (sql: string, ...values: SqlValue[]): SqlStatement => ({ sql, values });
const sameSource = `r.instance_id = i.id AND r.plugin_id = i.plugin_id AND r.epoch = i.epoch
  AND r.plugin_revision = p.revision AND r.plugin_generation = p.generation`;
const currentSource = `i.id = ? AND i.plugin_id = ? AND i.epoch = ? AND p.revision = ? AND p.generation = ? AND p.status = 'active'`;
const sourceValues = (snapshot: InstanceSnapshot): SqlValue[] => [snapshot.id, snapshot.pluginId, snapshot.epoch, snapshot.pluginRevision, snapshot.pluginGeneration];
const exactSnapshot = `${currentSource} AND i.name = ? AND i.config = ? AND i.private_state = ?
  AND i.state_revision = ? AND i.authentication IS ?`;
const snapshotValues = (snapshot: InstanceSnapshot): SqlValue[] => [...sourceValues(snapshot), snapshot.name,
  JSON.stringify(snapshot.config), JSON.stringify(snapshot.privateState), snapshot.stateRevision,
  snapshot.authentication === null ? null : JSON.stringify(snapshot.authentication)];

/** Ordinary state writes cannot consume the revision reserved by a live renewal. */
export const noActiveRenewalSQL = `NOT EXISTS (SELECT 1 FROM source_renewals r JOIN installations p ON p.id = instances.plugin_id
  WHERE r.instance_id = instances.id AND r.plugin_id = instances.plugin_id AND r.epoch = instances.epoch
  AND r.plugin_revision = p.revision AND r.plugin_generation = p.generation AND r.state_revision = instances.state_revision
  AND r.lease_token IS NOT NULL AND r.lease_until > CAST(unixepoch('subsec') * 1000 AS INTEGER))`;

export function renewalClaimFromRow(row: RenewalClaimRow | null | undefined): RenewalClaim {
  if (!row || row.kind === 'retry') return { kind: 'retry' };
  if (row.kind === 'busy') return { kind: 'busy', until: row.lease_until! };
  if (row.kind === 'failed') return { kind: 'failed', error: JSON.parse(row.fault!) as PluginFault };
  return { kind: 'acquired', snapshot: { id: row.id, pluginId: row.plugin_id, name: row.name, config: JSON.parse(row.config),
    privateState: JSON.parse(row.private_state), epoch: row.epoch, stateRevision: row.state_revision,
    pluginRevision: row.revision, pluginGeneration: row.generation,
    authentication: row.authentication === null ? null : JSON.parse(row.authentication) as AuthenticationRecord } };
}

/** The fresh marker guards every dependent write inside the SQLite transaction / D1 batch. */
export function claimRenewalPlan(expected: InstanceSnapshot, token: string, now: number, until: number): SqlStatement[] {
  if (!token || !Number.isFinite(now) || !Number.isFinite(until) || until <= now) throw new Error('Invalid source renewal lease');
  const marker = crypto.randomUUID();
  return [
    statement(`INSERT INTO source_renewals (instance_id, plugin_id, epoch, plugin_revision, plugin_generation, state_revision,
      lease_token, lease_until, fault, retry_at, mutation_token)
      SELECT i.id, i.plugin_id, i.epoch, p.revision, p.generation, i.state_revision + 1, ?, ?, NULL, 0, ?
      FROM instances i JOIN installations p ON p.id = i.plugin_id WHERE ${exactSnapshot}
      AND NOT EXISTS (SELECT 1 FROM source_renewals r WHERE ${sameSource} AND r.state_revision = i.state_revision
        AND ((r.lease_token IS NOT NULL AND r.lease_until > ?) OR (r.fault IS NOT NULL AND r.retry_at > ?)))
      ON CONFLICT(instance_id) DO UPDATE SET plugin_id = excluded.plugin_id, epoch = excluded.epoch,
        plugin_revision = excluded.plugin_revision, plugin_generation = excluded.plugin_generation, state_revision = excluded.state_revision,
        lease_token = excluded.lease_token, lease_until = excluded.lease_until, fault = NULL, retry_at = 0, mutation_token = excluded.mutation_token`,
    token, until, marker, ...snapshotValues(expected), now, now),
    statement(`UPDATE instances SET state_revision = state_revision + 1 WHERE id = ?
      AND EXISTS (SELECT 1 FROM source_renewals WHERE instance_id = ? AND mutation_token = ?)`, expected.id, expected.id, marker),
    statement(`SELECT i.*, p.revision, p.generation, r.lease_until, r.fault,
      CASE WHEN r.mutation_token = ? THEN 'acquired'
        WHEN r.state_revision = i.state_revision AND r.lease_token IS NOT NULL AND r.lease_until > ? THEN 'busy'
        WHEN r.state_revision = i.state_revision AND r.fault IS NOT NULL AND r.retry_at > ? THEN 'failed'
        ELSE 'retry' END AS kind
      FROM instances i JOIN installations p ON p.id = i.plugin_id LEFT JOIN source_renewals r ON ${sameSource}
      WHERE ${currentSource}`, marker, now, now, ...sourceValues(expected))
  ];
}

export function finishRenewalPlan(expected: InstanceSnapshot, token: string, outcome: Outcome<null>, now: number, retryAt: number): SqlStatement[] {
  if (!token || !Number.isFinite(now) || !Number.isFinite(retryAt)) throw new Error('Invalid source renewal completion');
  const marker = crypto.randomUUID();
  const written = statement('SELECT 1 FROM source_renewals WHERE instance_id = ? AND mutation_token = ?', expected.id, marker);
  const state = outcome.nextPrivateState === undefined ? [] : [JSON.stringify(outcome.nextPrivateState)];
  return [
    statement(`UPDATE source_renewals SET state_revision = state_revision + 1, lease_token = NULL, lease_until = 0,
      fault = ?, retry_at = ?, mutation_token = ?
      WHERE instance_id = ? AND lease_token = ? AND lease_until > ? AND state_revision = ?
      AND EXISTS (SELECT 1 FROM instances i JOIN installations p ON p.id = i.plugin_id
        WHERE ${sameSource.replaceAll('r.', 'source_renewals.')} AND ${exactSnapshot})`,
    outcome.ok ? null : JSON.stringify(outcome.error), outcome.ok ? 0 : retryAt, marker,
    expected.id, token, now, expected.stateRevision, ...snapshotValues(expected)),
    statement(`UPDATE instances SET ${state.length ? 'private_state = ?, ' : ''}state_revision = state_revision + 1
      WHERE id = ? AND EXISTS (${written.sql})`, ...state, expected.id, ...written.values),
    statement(`SELECT 1 AS accepted FROM source_renewals WHERE instance_id = ? AND mutation_token = ?`, expected.id, marker)
  ];
}

export function releaseRenewalStatement(instanceId: string, token: string): SqlStatement {
  return statement(`UPDATE source_renewals SET lease_token = NULL, lease_until = 0, mutation_token = NULL
    WHERE instance_id = ? AND lease_token = ?`, instanceId, token);
}
