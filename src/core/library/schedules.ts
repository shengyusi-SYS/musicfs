import { z } from 'zod';
import type { RefreshPolicy } from '../../contracts/refresh-policy';
import { SourceError, type Sources } from '../sources';
import type { Refreshes, RefreshView } from './refresh-types';
import type { SnapshotKey } from './types';

type Stored<T> = T | Promise<T>;
export type RefreshSchedule = { instanceId: string; key: SnapshotKey; intervalMinutes: number; nextRunAt: number };
export interface RefreshScheduleStore {
  refreshSchedule(instanceId: string, key: SnapshotKey): Stored<RefreshSchedule | null>;
  saveRefreshSchedule(instanceId: string, key: SnapshotKey, intervalMinutes: number, nextRunAt: number): Stored<void>;
  /** Atomically select one eligible due schedule and advance from now, never replay missed intervals. */
  claimDueRefreshSchedule(now: number): Stored<RefreshSchedule | null>;
  /** Active same-instance jobs own the next wakeup, so blocked schedules must not return a past instant. */
  nextRefreshScheduleAt(): Stored<number | null>;
}

const interval = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).refine(value => value === 0 || value >= 15);
const keyOf = (directoryRef?: string): SnapshotKey => directoryRef === undefined ? { kind: 'roots', ref: '' } : { kind: 'directory', ref: directoryRef };
const project = (record: RefreshSchedule | null): RefreshPolicy => ({ intervalMinutes: record?.intervalMinutes ?? 0,
  nextRunAt: record ? new Date(record.nextRunAt).toISOString() : null });

/** Timers only enqueue ordinary refresh work; publication, retries and cooldown remain owned by refreshes. */
export function createRefreshSchedules(sources: Sources, refreshes: Refreshes, store: Partial<RefreshScheduleStore>, now: () => number = Date.now) {
  return {
    async get(instanceId: string, directoryRef?: string): Promise<RefreshPolicy> {
      await sources.view(instanceId);
      return project(await store.refreshSchedule?.(instanceId, keyOf(directoryRef)) ?? null);
    },
    async set(instanceId: string, intervalMinutes: number, directoryRef?: string): Promise<RefreshPolicy> {
      const minutes = interval.refine(value => Number.isFinite(new Date(now() + value * 60_000).getTime())).parse(intervalMinutes);
      const instant = now() + minutes * 60_000;
      await sources.view(instanceId);
      if (!store.saveRefreshSchedule) throw new Error('Refresh schedules require persistent storage');
      const key = keyOf(directoryRef);
      await store.saveRefreshSchedule(instanceId, key, minutes, instant);
      return project(minutes ? { instanceId, key, intervalMinutes: minutes, nextRunAt: instant } : null);
    },
    async stepNext(signal: AbortSignal): Promise<RefreshView | null> {
      signal.throwIfAborted();
      const due = await store.claimDueRefreshSchedule?.(now());
      if (!due) return null;
      try {
        const stamp = await sources.view(due.instanceId);
        signal.throwIfAborted();
        return await refreshes.ensure(stamp, due.key);
      } catch (error) {
        // A source removed or changed after selection waits for its next normal interval.
        if (error instanceof SourceError) return null;
        throw error;
      }
    },
    async nextAt(): Promise<number | null> { return await store.nextRefreshScheduleAt?.() ?? null; }
  };
}
