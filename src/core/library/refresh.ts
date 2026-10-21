import { z } from 'zod';
import type { Entry, Page, Root } from '@musicfs/plugin-api';
import { SourceError, type Sources, type SourceStamp } from '../sources';
import { LibraryError, type LibraryStore, type SnapshotKey } from './types';
import { assertInfo } from './file-info';
import type { RefreshFailure, RefreshPage, RefreshRecord, RefreshScope, RefreshStore, RefreshTask, RefreshView, Refreshes } from './refresh-types';

const active = (status: RefreshRecord['status']) => status === 'queued' || status === 'running';
const temporaryRetryDelays = [2_000, 8_000];
const sameStamp = (a: SourceStamp, b: SourceStamp) => a.id === b.id && a.epoch === b.epoch
  && a.pluginRevision === b.pluginRevision && a.pluginGeneration === b.pluginGeneration;
const task = (key: SnapshotKey): RefreshTask => ({ key, attemptId: crypto.randomUUID(), pages: 0, entries: 0, children: [] });
const counters = z.record(z.string().min(1).max(64), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const workProgress = z.object({ completed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), unit: z.string().min(1).max(32) });
const staleFailure = (): RefreshFailure => ({ code: 'stale_call', message: '来源或刷新操作已发生变化，本次结果没有发布。' });
const failureOf = (error: unknown): RefreshFailure => error instanceof LibraryError
  ? { code: error.code, message: error.message, ...(error.sourceFault ? { sourceFault: error.sourceFault } : {}) }
  : { code: 'source_failed', message: error instanceof SourceError ? error.message : '目录刷新失败，请重试。' };

export function createRefreshes(sources: Sources, store: LibraryStore & RefreshStore,
  budgets: { pages: number; entries: number; directories?: number }, now: () => number = Date.now): Refreshes {
  const timestamp = () => new Date(now()).toISOString();
  const project = (record: RefreshRecord): RefreshView => ({ operationId: record.operationId, instanceId: record.stamp.id,
    scope: record.scope, status: record.status, current: record.task ? { kind: record.task.key.kind, directoryRef: record.task.key.ref,
      pages: record.task.pages, entries: record.task.entries, statistics: record.task.statistics ?? null,
      ...(record.task.progress ? { progress: record.task.progress } : {}) } : null,
    refreshedDirectories: record.refreshedDirectories, failures: record.failures, ...(record.error ? { error: record.error } : {}),
    createdAt: record.createdAt, updatedAt: record.updatedAt, ...(record.retryAt === undefined ? {} : { retryAt: new Date(record.retryAt).toISOString() }) });
  async function view(record: RefreshRecord): Promise<RefreshView> {
    return project(active(record.status) && !await sources.current(record.stamp)
      ? { ...record, status: 'superseded', error: staleFailure() } : record);
  }
  async function create(stamp: SourceStamp, scope: RefreshScope, replace: boolean): Promise<RefreshView> {
    const key: SnapshotKey = scope.kind === 'instance' || scope.directoryRef === undefined ? { kind: 'roots', ref: '' }
      : { kind: 'directory', ref: scope.directoryRef };
    const date = timestamp();
    const previous = await store.currentRefresh(stamp.id);
    const cooling = previous && sameStamp(previous.stamp, stamp) && previous.error?.sourceFault?.kind === 'rate_limited'
      && (previous.retryAt ?? 0) > now() ? previous : undefined;
    return view(await store.createRefresh({ operationId: crypto.randomUUID(), stamp, scope, status: 'queued', revision: 1,
      leaseToken: null, leaseUntil: null, task: task(key), pending: [], seen: [],
      known: scope.kind === 'instance' ? await store.knownDirectoryRefs(stamp.id) : [], refreshedDirectories: 0, failures: [],
      createdAt: date, updatedAt: date, ...(cooling ? { retryAt: cooling.retryAt!, rateLimitRetries: cooling.rateLimitRetries ?? 0,
        ...(cooling.error ? { error: cooling.error } : {}) } : {}) }, replace));
  }
  function appendUnique(target: string[], values: string[], seen: string[]) {
    const included = new Set([...seen, ...target]);
    for (const value of values) if (!included.has(value)) { target.push(value); included.add(value); }
  }
  function advance(record: RefreshRecord) {
    delete record.retryAt; delete record.rateLimitRetries; delete record.temporaryRetries; delete record.error;
    if (record.scope.kind !== 'instance' || !record.pending.length) { record.status = 'completed'; return; }
    if (record.seen.length >= (budgets.directories ?? 1000)) {
      record.status = 'failed'; record.error = { code: 'invalid_source', message: 'Instance refresh directory budget exceeded' }; return;
    }
    const next = record.pending.shift()!; record.seen.push(next);
    record.task = task({ kind: 'directory', ref: next }); record.status = 'running';
  }
  function acceptPage(record: RefreshRecord, page: Page<Root> | Page<Entry>): { next: RefreshRecord; page: RefreshPage } {
    const previous = record.task!;
    if (previous.pages >= budgets.pages) throw new LibraryError('invalid_source', 'Source pagination budget exceeded');
    if (!page || !Array.isArray(page.items)) throw new LibraryError('invalid_source', 'Source returned an invalid page');
    const next = structuredClone(record); const current = next.task!;
    delete next.retryAt; delete next.rateLimitRetries; delete next.temporaryRetries; delete next.error;
    if (page.progress !== undefined) {
      const parsed = workProgress.safeParse(page.progress);
      if (!parsed.success || parsed.data.completed > parsed.data.total || current.progress &&
        (current.progress.total !== parsed.data.total || current.progress.unit !== parsed.data.unit || current.progress.completed > parsed.data.completed)) {
        throw new LibraryError('invalid_source', 'Source returned inconsistent work progress');
      }
      current.progress = parsed.data;
    }
    const counterKeys = JSON.stringify(Object.keys(page.statistics ?? {}).sort());
    if (current.counterKeys !== undefined && current.counterKeys !== counterKeys) throw new LibraryError('invalid_source', 'Source page counters changed during pagination');
    current.counterKeys = counterKeys;
    if (page.statistics !== undefined) {
      const parsed = counters.safeParse(page.statistics);
      if (!parsed.success || Object.keys(parsed.data).length > 100) throw new LibraryError('invalid_source', 'Source returned invalid page counters');
      current.statistics ??= {};
      for (const [key, value] of Object.entries(parsed.data)) {
        const total = (current.statistics[key] ?? 0) + value;
        if (!Number.isSafeInteger(total)) throw new LibraryError('invalid_source', 'Source counter total overflowed');
        current.statistics[key] = total;
      }
    }
    const identities = new Set<string>();
    for (const item of page.items) {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string') throw new LibraryError('invalid_source', 'Source returned an invalid directory entry');
      const identity = previous.key.kind === 'roots' && 'sourceId' in item ? item.sourceId : 'entryId' in item ? item.entryId : undefined;
      if (typeof identity !== 'string' || !identity || identities.has(identity)) throw new LibraryError('invalid_source', 'Source repeated a directory occurrence identity');
      identities.add(identity);
      if (previous.key.kind === 'roots') {
        if (!('sourceId' in item) || typeof item.directoryRef !== 'string') throw new LibraryError('invalid_source', 'Source returned an invalid content source');
      } else if (!('entryId' in item) || !(item.kind === 'file' && typeof item.fileRef === 'string'
        || item.kind === 'directory' && typeof item.directoryRef === 'string')) throw new LibraryError('invalid_source', 'Source returned an invalid directory entry');
      if ('kind' in item && item.kind === 'file' && item.info !== undefined) assertInfo(item.info);
    }
    current.pages++; current.entries += page.items.length;
    if (current.entries > budgets.entries) throw new LibraryError('invalid_source', 'Source entry budget exceeded');
    if (next.scope.kind === 'instance') {
      if (previous.key.kind === 'roots') appendUnique(next.pending, (page.items as Root[]).map(item => item.directoryRef), next.seen);
      else appendUnique(current.children, (page.items as Entry[]).flatMap(item => item.kind === 'directory' && next.known.includes(item.directoryRef) ? [item.directoryRef] : []), next.seen);
    }
    const accepted: RefreshPage = { items: page.items };
    if (page.nextCursor !== undefined) {
      if (typeof page.nextCursor !== 'string') throw new LibraryError('invalid_source', 'Source returned an invalid page cursor');
      current.cursor = page.nextCursor; accepted.nextCursor = page.nextCursor; next.status = 'running';
    } else {
      delete current.cursor;
      accepted.publish = { stamp: record.stamp, id: previous.attemptId, kind: previous.key.kind,
        completedAt: timestamp(), ...(current.statistics ? { statistics: current.statistics } : {}) };
      if (previous.key.kind === 'directory') {
        next.refreshedDirectories++;
        appendUnique(next.pending, current.children, next.seen);
      }
      advance(next);
    }
    return { next, page: accepted };
  }
  const checkpoint = (expected: RefreshRecord, next: RefreshRecord) => ({ ...next, revision: expected.revision + 1,
    leaseToken: null, leaseUntil: null, updatedAt: timestamp() });
  const superseded = async (record: RefreshRecord) => view(await store.refreshRecord(record.operationId)
    ?? { ...record, status: 'superseded', error: staleFailure() });
  async function step(operationId: string, signal: AbortSignal): Promise<RefreshView> {
    const stored = await store.refreshRecord(operationId);
    if (!stored) throw new LibraryError('not_found', 'Refresh operation was not found');
    if (!active(stored.status) || !await sources.current(stored.stamp)) return view(stored);
    signal.throwIfAborted();
    const instant = now();
    if (stored.retryAt !== undefined && stored.retryAt > instant) return view(stored);
    const claimed = await store.claimRefresh(operationId, crypto.randomUUID(), instant, instant + 120_000);
    if (!claimed) return view(await store.refreshRecord(operationId) ?? { ...stored, status: 'superseded', error: staleFailure() });
    try {
      signal.throwIfAborted();
      if (!claimed.task || !sameStamp(await sources.view(claimed.stamp.id), claimed.stamp)) throw new LibraryError('stale_call', staleFailure().message);
      const current = claimed.task;
      if (current.pages >= budgets.pages) throw new LibraryError('invalid_source', 'Source pagination budget exceeded');
      const outcome = current.key.kind === 'roots' ? await sources.roots(claimed.stamp.id, signal, current.cursor)
        : await sources.list(claimed.stamp.id, current.key.ref, signal, current.cursor);
      signal.throwIfAborted();
      if (!outcome.ok) throw new LibraryError('source_failed', outcome.error.message, outcome.error);
      const accepted = acceptPage(claimed, outcome.value);
      const next = checkpoint(claimed, accepted.next);
      const result = await store.commitRefresh(claimed, next, accepted.page);
      if (result === 'duplicate_entry') throw new LibraryError('invalid_source', 'Source repeated a directory occurrence identity');
      if (result === 'cyclic_cursor') throw new LibraryError('invalid_source', 'Source returned a cyclic page cursor');
      return result === 'stale' ? superseded(claimed) : project(next);
    } catch (error) {
      if (signal.aborted) {
        // A disconnected step releases its lease; it does not cancel the persistent operation.
        await store.commitRefresh(claimed, checkpoint(claimed, claimed));
        throw signal.reason;
      }
      const next = structuredClone(claimed);
      delete next.retryAt;
      const sourceFault = failureOf(error).sourceFault;
      if (!await sources.current(claimed.stamp) || error instanceof SourceError && ['stale_call', 'missing_instance'].includes(error.code)
        || error instanceof LibraryError && error.code === 'stale_call') {
        next.status = 'superseded'; next.error = staleFailure();
      } else if (sourceFault?.kind === 'rate_limited' && (claimed.rateLimitRetries ?? 0) < 5) {
        const suggested = sourceFault.retryAfterSeconds;
        const seconds = suggested !== undefined && Number.isFinite(suggested) && suggested >= 0 ? suggested : Math.min(300, 30 * 2 ** (claimed.rateLimitRetries ?? 0));
        next.status = 'running'; next.retryAt = now() + Math.max(1, seconds) * 1000;
        next.rateLimitRetries = (claimed.rateLimitRetries ?? 0) + 1; next.error = failureOf(error);
        const saved = checkpoint(claimed, next);
        return await store.commitRefresh(claimed, saved) === 'stale' ? superseded(claimed) : project(saved);
      } else if (sourceFault?.kind === 'rate_limited') {
        next.status = 'failed'; next.error = failureOf(error);
      } else if (sourceFault?.kind === 'temporary' && (claimed.temporaryRetries ?? 0) < temporaryRetryDelays.length) {
        next.status = 'running'; next.retryAt = now() + temporaryRetryDelays[claimed.temporaryRetries ?? 0]!;
        next.temporaryRetries = (claimed.temporaryRetries ?? 0) + 1; next.error = failureOf(error);
        const saved = checkpoint(claimed, next);
        return await store.commitRefresh(claimed, saved) === 'stale' ? superseded(claimed) : project(saved);
      } else if (claimed.scope.kind === 'instance' && claimed.task?.key.kind === 'directory') {
        next.failures.push({ directoryRef: claimed.task.key.ref, error: failureOf(error) });
        advance(next);
      } else { next.status = 'failed'; next.error = failureOf(error); }
      const saved = checkpoint(claimed, next);
      const result = await store.commitRefresh(claimed, saved, undefined, failureOf(error).sourceFault?.kind ?? failureOf(error).code);
      return result === 'stale' ? superseded(claimed) : project(saved);
    }
  }
  return {
    start: async (instanceId, scope) => create(await sources.view(instanceId), scope, true),
    ensure: (stamp, key) => create(stamp, { kind: 'directory', ...(key.kind === 'directory' ? { directoryRef: key.ref } : {}) }, false),
    get: async operationId => { const record = await store.refreshRecord(operationId); return record ? view(record) : null; },
    current: async instanceId => { const record = await store.currentRefresh(instanceId); return record ? view(record) : null; },
    step,
    async cancel(operationId) { await store.cancelRefresh(operationId, timestamp()); const record = await store.refreshRecord(operationId); return record ? view(record) : null; },
    async stepNext(signal) { const [id] = await store.readyRefreshes(now(), 1); return id ? step(id, signal) : null; }
  };
}
