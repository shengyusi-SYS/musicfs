import { z } from 'zod';
import { sameUpdateTarget, type RefreshPolicy, type UpdateRule, type UpdateRuleInput, type UpdateTarget } from '../../contracts/refresh-policy';
import { SourceError, type Sources } from '../sources';
import type { Refreshes, RefreshScope, RefreshView } from './refresh-types';
import { LibraryError, type SnapshotKey } from './types';
import { nextUpdateAt, updateRuleInput } from './update-timing';

type Stored<T> = T | Promise<T>;
export type RefreshSchedule = Omit<UpdateRuleInput, 'label'> & {
  id: string; label: string | null; revision: number; nextRunAt: number | null;
  operationId: string | null; lastRunAt: number | null; settled: boolean;
};
export interface RefreshScheduleStore {
  updateRule(id: string): Stored<RefreshSchedule | null>;
  updateRules(): Stored<RefreshSchedule[]>;
  completedUpdateRules(): Stored<RefreshSchedule[]>;
  saveUpdateRule(rule: RefreshSchedule): Stored<RefreshSchedule>;
  removeUpdateRule(id: string): Stored<void>;
  /** Read only: a due time is consumed only by the refresh creation transaction. */
  dueUpdateRule(now: number): Stored<RefreshSchedule | null>;
  finishUpdateRule(rule: RefreshSchedule, nextRunAt: number | null): Stored<void>;
  /** Active unrelated same-instance jobs own the next wakeup. */
  nextRefreshScheduleAt(): Stored<number | null>;
}

const active = (view: RefreshView | null) => view?.status === 'queued' || view?.status === 'running';
const targetOf = (key: SnapshotKey): UpdateTarget => key.kind === 'roots' ? { kind: 'roots' }
  : { kind: 'directory', directoryRef: key.ref, recursive: false };
const keyOf = (directoryRef?: string): SnapshotKey => directoryRef === undefined ? { kind: 'roots', ref: '' } : { kind: 'directory', ref: directoryRef };
export class UpdateRuleExistsError extends LibraryError {
  constructor(public readonly ruleId: string) {
    super('conflict', '此范围已有自动更新规则，请编辑已有规则。');
    this.name = 'UpdateRuleExistsError';
  }
}
export const scopeOfUpdate = (target: UpdateTarget): RefreshScope => target.kind === 'instance' ? { kind: 'instance' }
  : target.kind === 'roots' ? { kind: 'directory' }
    : { kind: 'directory', directoryRef: target.directoryRef, ...(target.recursive ? { recursive: true } : {}) };

/** Timing and target selection only; the existing refresh queue owns execution, publication and retries. */
export function createRefreshSchedules(sources: Sources, refreshes: Refreshes, store: Partial<RefreshScheduleStore>, now: () => number = Date.now) {
  function persistent(): RefreshScheduleStore {
    if (!store.updateRule || !store.updateRules || !store.completedUpdateRules || !store.saveUpdateRule || !store.removeUpdateRule
      || !store.dueUpdateRule || !store.finishUpdateRule || !store.nextRefreshScheduleAt) throw new Error('Update rules require persistent storage');
    return store as RefreshScheduleStore;
  }
  async function find(id: string): Promise<RefreshSchedule> {
    const value = await persistent().updateRule(id);
    if (!value) throw new LibraryError('not_found', '自动更新规则不存在。');
    return value;
  }
  async function settle() {
    for (const rule of await store.completedUpdateRules?.() ?? []) {
      if (!rule.operationId) continue;
      const operation = await refreshes.get(rule.operationId);
      if (active(operation)) continue;
      // One catch-up only. Intervals start at completion; calendar schedules remain tied to the clock.
      const completed = operation ? Date.parse(operation.updatedAt) : now();
      await persistent().finishUpdateRule(rule, rule.enabled ? nextUpdateAt(rule.timing, completed) : null);
    }
  }
  async function project(rule: RefreshSchedule): Promise<UpdateRule> {
    const operation = rule.operationId ? await refreshes.get(rule.operationId) : null;
    return { id: rule.id, instanceId: rule.instanceId, target: rule.target, timing: rule.timing, enabled: rule.enabled,
      label: rule.label, nextRunAt: rule.nextRunAt === null ? null : new Date(rule.nextRunAt).toISOString(),
      lastRunAt: rule.lastRunAt === null ? null : new Date(rule.lastRunAt).toISOString(), operationId: rule.operationId,
      status: operation?.status ?? null, failedDirectories: operation?.failures.length ?? 0 };
  }
  async function save(input: UpdateRuleInput, previous?: RefreshSchedule): Promise<UpdateRule> {
    const value = updateRuleInput.parse(input);
    await sources.view(value.instanceId);
    const duplicate = (await persistent().updateRules()).find(rule => rule.instanceId === value.instanceId
      && sameUpdateTarget(rule.target, value.target) && rule.id !== previous?.id);
    if (duplicate) throw new UpdateRuleExistsError(duplicate.id);
    const keepsTarget = previous !== undefined && previous.instanceId === value.instanceId && sameUpdateTarget(previous.target, value.target);
    const operationId = keepsTarget ? previous!.operationId : null;
    const running = active(operationId ? await refreshes.get(operationId) : null);
    return project(await persistent().saveUpdateRule({ ...value, id: previous?.id ?? crypto.randomUUID(),
      label: value.label ?? previous?.label ?? null, revision: (previous?.revision ?? 0) + 1,
      nextRunAt: running ? null : value.enabled ? nextUpdateAt(value.timing, now()) : null, settled: !running,
      operationId, lastRunAt: keepsTarget ? previous!.lastRunAt : null }));
  }
  async function enqueue(rule: RefreshSchedule, signal: AbortSignal, manual = false): Promise<RefreshView | null> {
    signal.throwIfAborted();
    try {
      const stamp = await sources.view(rule.instanceId);
      signal.throwIfAborted();
      return await refreshes.ensureScheduled(stamp, scopeOfUpdate(rule.target), { ruleId: rule.id, revision: rule.revision, now: now(), ...(manual ? { manual: true } : {}) });
    } catch (error) {
      if (error instanceof SourceError && ['missing_instance', 'stale_call'].includes(error.code)) return null;
      throw error;
    }
  }
  return {
    async list(): Promise<UpdateRule[]> { await settle(); return Promise.all((await store.updateRules?.() ?? []).map(project)); },
    create: (input: UpdateRuleInput) => save(input),
    async update(id: string, input: UpdateRuleInput): Promise<UpdateRule> { return save(input, await find(id)); },
    async remove(id: string): Promise<void> { await find(id); await persistent().removeUpdateRule(id); },
    async run(id: string, signal: AbortSignal): Promise<RefreshView> {
      const operation = await enqueue(await find(id), signal, true);
      if (!operation) throw new LibraryError('conflict', '当前来源正在更新其他目录，请完成后再执行此规则。');
      return operation;
    },
    async get(instanceId: string, directoryRef?: string): Promise<RefreshPolicy> {
      await sources.view(instanceId); await settle();
      const target = targetOf(keyOf(directoryRef));
      const rule = (await store.updateRules?.() ?? []).find(rule => rule.instanceId === instanceId && sameUpdateTarget(rule.target, target));
      return { intervalMinutes: rule?.enabled && rule.timing.kind === 'interval' ? rule.timing.minutes : 0,
        nextRunAt: rule?.nextRunAt == null ? null : new Date(rule.nextRunAt).toISOString() };
    },
    async set(instanceId: string, intervalMinutes: number, directoryRef?: string): Promise<RefreshPolicy> {
      const minutes = z.number().int().nonnegative().max(525_600).refine(value => value === 0 || value >= 15).parse(intervalMinutes);
      await sources.view(instanceId);
      const target = targetOf(keyOf(directoryRef));
      const previous = (await persistent().updateRules()).find(rule => rule.instanceId === instanceId && sameUpdateTarget(rule.target, target));
      if (minutes === 0) { if (previous) await persistent().removeUpdateRule(previous.id); return { intervalMinutes: 0, nextRunAt: null }; }
      const value = await save({ instanceId, enabled: true, target, timing: { kind: 'interval', minutes } }, previous);
      return { intervalMinutes: minutes, nextRunAt: value.nextRunAt };
    },
    async stepNext(signal: AbortSignal): Promise<RefreshView | null> {
      signal.throwIfAborted(); await settle();
      const due = await store.dueUpdateRule?.(now());
      return due ? enqueue(due, signal) : null;
    },
    async nextAt(): Promise<number | null> { await settle(); return await store.nextRefreshScheduleAt?.() ?? null; }
  };
}
