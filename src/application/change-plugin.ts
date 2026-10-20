import type { PluginManifest, SourcePlugin } from '@musicfs/plugin-api';
import type { Installation } from '../core/extensions';
import type { MigrationInput, PreparedMigration } from '../core/sources';
import type { PluginChange } from '../contracts/plugin-changes';
export type { MigrationInput, PreparedMigration } from '../core/sources';

/** Private, durable operation; only view may cross the management boundary. */
export type PluginChangeRecord = {
  view: PluginChange;
  expectedGeneration: number | null;
  previousManifest?: PluginManifest;
  manifest: PluginManifest;
  revision: string;
  inputsCaptured?: boolean;
  codeReady?: boolean;
  stagingReady?: boolean;
  /** Worker code-publication checkpoint; never executable code in the database. */
  registry?: string;
  attemptedAt?: number;
};
export type ChangeLease = { record: PluginChangeRecord; revision: number; token: string };
export type ChangeMutation = { kind: 'checkpoint' | 'capture' | 'fail' }
  | { kind: 'candidate'; instanceId: string; value: PreparedMigration }
  | { kind: 'activate'; migrateInstances: boolean };
type Stored<T> = T | Promise<T>;

/** SQLite and D1 perform the same conditional transaction, including operation completion. */
export interface PluginChangeStore {
  createChange(record: PluginChangeRecord): Stored<boolean>;
  changeRecord(operationId: string): Stored<PluginChangeRecord | null>;
  claimChange(operationId: string, token: string, now: number, until: number): Stored<ChangeLease | null>;
  commitChange(expected: ChangeLease, next: PluginChangeRecord, mutation: ChangeMutation, now: number): Stored<ChangeLease | null>;
  nextChangeInstance(operationId: string): Stored<MigrationInput | null>;
  releaseChange(operationId: string, token: string): Stored<void>;
  readyChanges(now: number, limit: number): Stored<string[]>;
}

export type CandidatePreparation = (previous: PluginManifest, target: PluginManifest, module: SourcePlugin,
  instance: MigrationInput, signal: AbortSignal) => Promise<PreparedMigration>;

export const terminalChange = (view: PluginChange) => view.status === 'completed' || view.status === 'failed';
export const needsMigration = (record: PluginChangeRecord) => record.view.kind === 'install' && record.previousManifest !== undefined
  && (record.previousManifest.configVersion !== record.manifest.configVersion || record.previousManifest.stateVersion !== record.manifest.stateVersion);
export const nextInstallation = (record: PluginChangeRecord): Installation => ({ manifest: record.manifest, revision: record.revision,
  generation: (record.expectedGeneration ?? 0) + 1, status: record.view.kind === 'install' ? 'active' : 'missing' });

/** Code preparation varies by host; candidate data and final activation do not. */
export function createPluginActivation(input: { store: PluginChangeStore; prepare: CandidatePreparation; now?: () => number }) {
  const now = input.now ?? Date.now;
  const timestamp = () => new Date(now()).toISOString();
  const checkpoint = (lease: ChangeLease, record: PluginChangeRecord) => input.store.commitChange(lease,
    { ...record, view: { ...record.view, updatedAt: timestamp() } }, { kind: 'checkpoint' }, now());
  const fail = (lease: ChangeLease, code: string, message: string) => input.store.commitChange(lease,
    { ...lease.record, view: { ...lease.record.view, status: 'failed' as const, updatedAt: timestamp(), error: { code, message } } }, { kind: 'fail' }, now());
  async function capture(lease: ChangeLease): Promise<ChangeLease | null> {
    if (!needsMigration(lease.record) || lease.record.inputsCaptured) return lease;
    const record = { ...lease.record, inputsCaptured: true,
      view: { ...lease.record.view, status: 'preparing' as const, updatedAt: timestamp() } };
    return await input.store.commitChange(lease, record, { kind: 'capture' }, now())
      ?? await fail(lease, 'revision_conflict', '插件或实例在准备期间发生变化，原安装保持不变。');
  }
  async function step(lease: ChangeLease, module: SourcePlugin | undefined, signal: AbortSignal): Promise<ChangeLease | null> {
    signal.throwIfAborted();
    if (!lease.record.codeReady || terminalChange(lease.record.view)) return lease;
    if (needsMigration(lease.record)) {
      if (!lease.record.inputsCaptured) return capture(lease);
      if (!module) return lease;
      const instance = await input.store.nextChangeInstance(lease.record.view.operationId);
      if (instance) {
        try {
          const value = await input.prepare(lease.record.previousManifest!, lease.record.manifest, module, instance, signal);
          signal.throwIfAborted();
          const record = { ...lease.record, view: { ...lease.record.view, status: 'migrating' as const, updatedAt: timestamp() } };
          return await input.store.commitChange(lease, record, { kind: 'candidate', instanceId: instance.id, value }, now())
            ?? await fail(lease, 'revision_conflict', '实例在升级准备期间发生变化，原安装保持不变。');
        } catch {
          if (signal.aborted) throw signal.reason;
          return fail(lease, 'migration_failed', `实例 ${instance.id} 未通过升级转换或验证，原安装和实例数据保持不变。`);
        }
      }
    }
    signal.throwIfAborted();
    const record: PluginChangeRecord = { ...lease.record,
      view: { ...lease.record.view, status: 'completed', updatedAt: timestamp(), installation: nextInstallation(lease.record) } };
    delete record.view.error;
    return await input.store.commitChange(lease, record, { kind: 'activate', migrateInstances: needsMigration(lease.record) }, now())
      ?? await fail(lease, 'revision_conflict', '插件或实例在升级期间发生变化，未切换安装或覆盖实例数据。');
  }
  return { capture, checkpoint, step, fail };
}
