import type { PluginFault, WorkProgress } from '@musicfs/plugin-api';

export type RefreshScope = { kind: 'instance' } | { kind: 'directory'; directoryRef?: string; recursive?: boolean }
  | { kind: 'file-info' | 'metadata'; directoryRef: string };
export type RefreshView = {
  operationId: string; instanceId: string; scope: RefreshScope;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'superseded' | 'cancelled';
  current: null | { kind: 'roots' | 'directory'; directoryRef: string; pages: number; entries: number; statistics: Record<string, number> | null; progress?: WorkProgress };
  refreshedDirectories: number;
  failures: { directoryRef: string; error: { code: string; message: string; sourceFault?: PluginFault } }[];
  error?: { code: string; message: string; sourceFault?: PluginFault };
  createdAt: string; updatedAt: string;
  retryAt?: string;
};
