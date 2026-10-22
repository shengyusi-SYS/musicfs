/** Legacy interval endpoint: a missing policy is manual and roots never imply a full instance. */
export type RefreshPolicy = { intervalMinutes: number; nextRunAt: string | null };

export type UpdateTiming =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string; timezone: string }
  | { kind: 'weekly'; time: string; timezone: string; weekdays: number[] };
export type UpdateTarget =
  | { kind: 'instance' }
  | { kind: 'roots' }
  | { kind: 'directory'; directoryRef: string; recursive: boolean };

/** A scope is identified by source references and recursion, independent of JSON property order. */
export function sameUpdateTarget(left: UpdateTarget, right: UpdateTarget): boolean {
  return left.kind === right.kind && (left.kind !== 'directory' || right.kind === 'directory'
    && left.directoryRef === right.directoryRef && left.recursive === right.recursive);
}
export type UpdateRuleInput = {
  instanceId: string; target: UpdateTarget; timing: UpdateTiming; enabled: boolean;
  /** Context name only; opaque source references remain the target identity. */
  label?: string;
};
export type UpdateRule = Omit<UpdateRuleInput, 'label'> & {
  id: string; label: string | null; nextRunAt: string | null; lastRunAt: string | null;
  operationId: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'superseded' | 'cancelled' | null;
  /** A completed traversal may have individual directory failures. */
  failedDirectories: number;
};
