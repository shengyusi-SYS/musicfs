import type { Entry, Root, WorkProgress } from '@musicfs/plugin-api';
import type { SourceStamp } from '../sources';
import type { InstanceRefresh, Snapshot, SnapshotKey } from './types';

export type RefreshScope = { kind: 'instance' } | { kind: 'directory'; directoryRef?: string }
  | { kind: 'file-info'; directoryRef: string };
export type RefreshFailure = InstanceRefresh['failures'][number]['error'];
export type RefreshStatus = 'queued' | 'running' | 'completed' | 'failed' | 'superseded' | 'cancelled';
export type RefreshView = {
  operationId: string; instanceId: string; scope: RefreshScope; status: RefreshStatus;
  current: null | { kind: 'roots' | 'directory'; directoryRef: string; pages: number; entries: number; statistics: Record<string, number> | null; progress?: WorkProgress };
  refreshedDirectories: number; failures: InstanceRefresh['failures']; error?: RefreshFailure;
  createdAt: string; updatedAt: string;
  retryAt?: string;
};
export type RefreshTask = {
  key: SnapshotKey; attemptId: string; cursor?: string; pages: number; entries: number;
  pendingFileInfo?: number;
  counterKeys?: string; statistics?: Record<string, number>; children: string[];
  progress?: WorkProgress;
};
/** Private checkpoint: source state and credentials never enter this record. */
export type RefreshRecord = {
  operationId: string; stamp: SourceStamp; scope: RefreshScope; status: RefreshStatus;
  revision: number; leaseToken: string | null; leaseUntil: number | null;
  task: RefreshTask | null; pending: string[]; seen: string[]; known: string[];
  refreshedDirectories: number; failures: InstanceRefresh['failures']; error?: RefreshFailure;
  createdAt: string; updatedAt: string;
  retryAt?: number; rateLimitRetries?: number; temporaryRetries?: number;
};
export type SnapshotHeader = Pick<Snapshot, 'stamp' | 'id' | 'kind' | 'completedAt' | 'statistics' | 'pendingFileInfo'>;
export type RefreshPage = { items: (Root | Entry)[]; nextCursor?: string; publish?: SnapshotHeader };
type Stored<T> = T | Promise<T>;

/** All changes check the source stamp and lease/revision inside the database. */
export interface RefreshStore {
  /** Reuse an active same-instance job for an ordinary miss; explicit refresh replaces it. */
  createRefresh(record: RefreshRecord, replace: boolean): Stored<RefreshRecord>;
  refreshRecord(operationId: string): Stored<RefreshRecord | null>;
  currentRefresh(instanceId: string): Stored<RefreshRecord | null>;
  claimRefresh(operationId: string, token: string, now: number, until: number): Stored<RefreshRecord | null>;
  /** Append at expected.task's ordinal, then checkpoint; publication switches a pointer, never a cumulative JSON array. */
  commitRefresh(expected: RefreshRecord, next: RefreshRecord, page?: RefreshPage, directoryError?: string): Stored<'committed' | 'stale' | 'duplicate_entry' | 'cyclic_cursor'>;
  cancelRefresh(operationId: string, updatedAt: string): Stored<void>;
  readyRefreshes(now: number, limit: number): Stored<string[]>;
}

export interface Refreshes {
  start(instanceId: string, scope: RefreshScope): Promise<RefreshView>;
  get(operationId: string): Promise<RefreshView | null>;
  current(instanceId: string): Promise<RefreshView | null>;
  step(operationId: string, signal: AbortSignal): Promise<RefreshView>;
  cancel(operationId: string): Promise<RefreshView | null>;
  /** An ordinary cache miss reuses work instead of replacing it. */
  ensure(stamp: SourceStamp, key: SnapshotKey): Promise<RefreshView>;
  /** Prepare complete file properties through the same paged directory refresh. */
  ensureFileInfo(stamp: SourceStamp, directoryRef: string): Promise<RefreshView>;
  /** At most one plugin page; the host decides when a separate invocation runs. */
  stepNext(signal: AbortSignal): Promise<RefreshView | null>;
}
