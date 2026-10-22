import { z } from 'zod';
import type { ByteRange, FileInfo, Outcome, ReadResult } from '@musicfs/plugin-api';
import type { Sources, SourceStamp } from '../sources';
import { createPublishedViews, namedView, type NamedView, type PublishedViewLimits } from './published-views';
import { createRefreshes } from './refresh';
import { createRefreshSchedules, type RefreshScheduleStore } from './schedules';
import { assertInfo } from './file-info';
import type { RefreshScope, RefreshStore, RefreshView } from './refresh-types';
import { LibraryError, PendingRefreshError, type Description, type FileDescription, type FileView, type LayoutNode,
  type DirectoryStatus, type InstanceRefresh, type LibraryStore, type Snapshot, type SnapshotKey, type ViewEntry } from './types';
export * from './types';
export type { RefreshView, RefreshScope, Refreshes } from './refresh-types';

const epochDate = '1970-01-01T00:00:00.000Z';
const sameStamp = (a: SourceStamp, b: SourceStamp) => a.id === b.id && a.epoch === b.epoch
  && a.pluginRevision === b.pluginRevision && a.pluginGeneration === b.pluginGeneration;
const id = z.string().min(1).max(512);
const layoutNode: z.ZodType<LayoutNode> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('group'), id, name: id, children: z.array(layoutNode) }).strict(),
  z.object({ kind: z.literal('source'), id, name: id, instanceId: id, sourceId: id }).strict()
]));

function parseLayout(input: unknown): LayoutNode[] | null {
  if (input === null) return null;
  const pending: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  const visited = new Set<object>(); let count = 0;
  while (pending.length) {
    const next = pending.pop(); if (!next || next.depth > 32 || ++count > 20_000) throw new LibraryError('invalid_layout', 'Layout is too large or deep');
    const value = next.value;
    if (typeof value === 'object' && value !== null) {
      if (visited.has(value)) throw new LibraryError('invalid_layout', 'Layout contains repeated or circular objects');
      visited.add(value);
      if (Array.isArray(value)) for (const child of value) pending.push({ value: child, depth: next.depth + 1 });
      else if ('children' in value) pending.push({ value: value.children, depth: next.depth + 1 });
    }
  }
  const parsed = z.array(layoutNode).safeParse(input);
  if (!parsed.success) throw new LibraryError('invalid_layout', 'Invalid layout tree');
  const identifiers = new Set<string>();
  const visit = (nodes: LayoutNode[]) => {
    for (const node of nodes) {
      if (identifiers.has(node.id)) throw new LibraryError('invalid_layout', 'Layout node identities must be unique');
      identifiers.add(node.id); if (node.kind === 'group') visit(node.children);
    }
  };
  visit(parsed.data); return parsed.data;
}

function unwrap<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new LibraryError('source_failed', outcome.error.message, outcome.error);
  return outcome.value;
}
async function webSha256(input: Uint8Array): Promise<string> {
  // The caller creates these bytes with TextEncoder, never shared memory.
  const bytes = await crypto.subtle.digest('SHA-256', input as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Adds a byte-count check while retaining pull, cancellation, and source errors. */
function verifiedStream(body: ReadableStream<Uint8Array>, size: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  const reader = body.getReader(); let count = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const clear = () => signal.removeEventListener('abort', abort);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted();
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) {
          clear();
          if (count !== size) throw new LibraryError('invalid_source', 'Source audio stream ended before the declared length');
          controller.close(); return;
        }
        if (!(next.value instanceof Uint8Array) || (count += next.value.byteLength) > size) {
          throw new LibraryError('invalid_source', 'Source audio stream exceeded the declared length');
        }
        controller.enqueue(next.value);
      } catch (error) {
        clear(); await reader.cancel(error).catch(() => {}); controller.error(error);
      }
    },
    async cancel(reason) { clear(); await reader.cancel(reason); }
  }, { highWaterMark: 0 });
}

type Target =
  | { kind: 'layout'; nodes: LayoutNode[]; revision: number }
  | { kind: 'instances' }
  | { kind: 'instance'; instanceId: string }
  | { kind: 'source'; instanceId: string; sourceId: string }
  | { kind: 'directory'; stamp: SourceStamp; ref: string }
  | { kind: 'file'; stamp: SourceStamp; ref: string; info?: FileInfo; deferredDirectory?: string };
type Child = { id: string; name: string; target: Target; modifiedAt: string };
type Resolved = { target: Target; name: string; path: string; modifiedAt: string };
type MetadataGroup = { stamp: SourceStamp; entries: [ViewEntry, Resolved][] };

export function createLibrary(sources: Sources, store: LibraryStore & RefreshStore & Partial<RefreshScheduleStore>,
  budgets: { pages: number; entries: number; directories?: number } = { pages: 10_000, entries: 100_000 },
  options: { execution?: 'inline' | 'deferred'; sha256?: (bytes: Uint8Array) => string | Promise<string>; now?: () => number;
    publishedViews?: PublishedViewLimits } = {}) {
  const hash = options.sha256 ?? webSha256;
  const digest = (value: unknown) => hash(new TextEncoder().encode(JSON.stringify(value)));
  const refreshes = createRefreshes(sources, store, budgets, options.now);
  const schedules = createRefreshSchedules(sources, refreshes, store, options.now);
  async function drain(initial: RefreshView, signal: AbortSignal): Promise<RefreshView> {
    let progress = initial;
    try {
      while (progress.status === 'queued' || progress.status === 'running') {
        signal.throwIfAborted();
        const previous = JSON.stringify(progress.current);
        progress = await refreshes.step(progress.operationId, signal);
        if (progress.retryAt && Date.parse(progress.retryAt) > Date.now()) throw new PendingRefreshError(progress.operationId);
        if (progress.status === 'running' && JSON.stringify(progress.current) === previous) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
    } catch (error) {
      if (signal.aborted) await refreshes.cancel(progress.operationId);
      throw error;
    }
    if (progress.status !== 'completed') throw new LibraryError(progress.status === 'superseded' || progress.status === 'cancelled' ? 'stale_call'
      : progress.error?.code === 'invalid_source' ? 'invalid_source' : 'source_failed',
      progress.error?.message ?? 'Directory refresh did not complete', progress.error?.sourceFault);
    return progress;
  }
  async function refresh(stamp: SourceStamp, key: SnapshotKey, signal: AbortSignal): Promise<Snapshot> {
    signal.throwIfAborted();
    if (!await sources.current(stamp)) throw new LibraryError('stale_call', 'Source changed before refresh');
    const scope: RefreshScope = { kind: 'directory', ...(key.kind === 'directory' ? { directoryRef: key.ref } : {}) };
    const initial = await refreshes.start(stamp.id, scope);
    const record = await store.refreshRecord(initial.operationId);
    if (!record || !sameStamp(record.stamp, stamp)) throw new LibraryError('stale_call', 'Source changed before refresh');
    await drain(initial, signal);
    const published = await store.snapshot(stamp.id, key);
    if (!published?.value || !sameStamp(published.value.stamp, stamp) || !await sources.current(stamp)) {
      throw new LibraryError('stale_call', 'Source changed before refreshed content was read');
    }
    return published.value;
  }
  async function snapshot(stamp: SourceStamp, key: SnapshotKey, signal: AbortSignal): Promise<Snapshot> {
    for (;;) {
      signal.throwIfAborted();
      const cached = await store.snapshot(stamp.id, key);
      if (cached?.value && sameStamp(cached.value.stamp, stamp)) return cached.value;
      const pending = await refreshes.ensure(stamp, key);
      if (options.execution === 'deferred') throw new PendingRefreshError(pending.operationId);
      await drain(pending, signal);
      // A concurrent miss may have reused a job for another directory of this instance.
      // Read this key again; never return that other directory as this result.
    }
  }
  const publishedViews = createPublishedViews<Child>(store, snapshot, (value, key) => {
    const modifiedAt = value.contentModifiedAt ?? value.completedAt;
    return value.kind === 'roots'
      ? value.items.map(root => ({ id: root.sourceId, name: root.name, modifiedAt,
        target: { kind: 'directory', stamp: value.stamp, ref: root.directoryRef } }))
      : value.items.map(entry => ({ id: entry.entryId, name: entry.name,
        modifiedAt: entry.kind === 'file' ? entry.info?.modifiedAt ?? modifiedAt : modifiedAt,
        target: entry.kind === 'directory' ? { kind: 'directory', stamp: value.stamp, ref: entry.directoryRef }
          : { kind: 'file', stamp: value.stamp, ref: entry.fileRef, ...(entry.info === undefined ? {} : { info: entry.info }),
            ...(entry.deferredInfo === true && entry.info === undefined ? { deferredDirectory: key.ref } : {}) } }));
  }, options.publishedViews);
  async function refreshInstance(instanceId: string, signal: AbortSignal): Promise<InstanceRefresh> {
    signal.throwIfAborted();
    const result = await drain(await refreshes.start(instanceId, { kind: 'instance' }), signal);
    return { refreshedDirectories: result.refreshedDirectories, failures: result.failures };
  }
  async function rootsView(instanceId: string, signal: AbortSignal) {
    const stamp = await sources.view(instanceId);
    return publishedViews.get(stamp, { kind: 'roots', ref: '' }, signal);
  }
  async function sourceDirectory(target: Extract<Target, { kind: 'source' }>, signal: AbortSignal): Promise<Extract<Target, { kind: 'directory' }>> {
    const root = (await rootsView(target.instanceId, signal)).entries.find(item => item.id === target.sourceId);
    if (!root || root.target.kind !== 'directory') throw new LibraryError('not_found', 'Content source no longer exists');
    return root.target;
  }
  async function children(target: Target, signal: AbortSignal): Promise<NamedView<Child>> {
    if (target.kind === 'instances') return namedView((await sources.instances()).map(instance => ({
      id: instance.id, name: instance.name, target: { kind: 'instance', instanceId: instance.id }, modifiedAt: epochDate
    })) satisfies Child[]);
    if (target.kind === 'layout') return namedView(target.nodes.map(node => ({ id: node.id, name: node.name, modifiedAt: epochDate,
      target: node.kind === 'group' ? { kind: 'layout', nodes: node.children, revision: target.revision }
        : { kind: 'source', instanceId: node.instanceId, sourceId: node.sourceId } })) satisfies Child[]);
    if (target.kind === 'source') return children(await sourceDirectory(target, signal), signal);
    if (target.kind === 'instance') {
      const stamp = await sources.view(target.instanceId);
      return publishedViews.get(stamp, { kind: 'roots', ref: '' }, signal);
    }
    if (target.kind !== 'directory') throw new LibraryError('not_directory', 'Path is not a directory');
    if (!await sources.current(target.stamp)) throw new LibraryError('stale_call', 'Source changed');
    return publishedViews.get(target.stamp, { kind: 'directory', ref: target.ref }, signal);
  }
  async function root(): Promise<Target> {
    const layout = await store.layout();
    return layout.nodes === null ? { kind: 'instances' } : { kind: 'layout', nodes: layout.nodes, revision: layout.revision };
  }
  async function resolve(path: string, signal: AbortSignal): Promise<Resolved> {
    const segments = path.split('/').filter(Boolean);
    if (segments.some(part => part === '.' || part === '..' || /[\\\x00]/.test(part))) throw new LibraryError('not_found', 'Invalid export path');
    let target = await root(); let name = ''; let canonical = ''; let modifiedAt = epochDate;
    for (const segment of segments) {
      const next = (await children(target, signal)).byName.get(segment);
      if (!next) throw new LibraryError('not_found', 'Export path not found');
      target = next.target; name = next.pathName; canonical += `/${name}`; modifiedAt = next.modifiedAt;
    }
    return { target, name, path: canonical || '/', modifiedAt };
  }
  // A listed entry keeps its resolved target only while its caller retains that object.
  // Serialized or externally created entries still resolve through the ordinary path boundary.
  const listedEntries = new WeakMap<ViewEntry, Resolved>();
  async function listResolved(resolved: Resolved, signal: AbortSignal): Promise<ViewEntry[]> {
    return (await children(resolved.target, signal)).entries.map(entry => {
      const view: ViewEntry = { kind: entry.target.kind === 'file' ? 'file' : 'directory', name: entry.pathName,
        path: `${resolved.path === '/' ? '' : resolved.path}/${entry.pathName}`, modifiedAt: entry.modifiedAt };
      listedEntries.set(view, { target: entry.target, name: view.name, path: view.path, modifiedAt: view.modifiedAt });
      return view;
    });
  }
  async function publishedStatus(stamp: SourceStamp, directoryRef: string): Promise<DirectoryStatus | null> {
    const cached = await store.snapshotHeader(stamp.id, { kind: 'directory', ref: directoryRef });
    if (!cached || !sameStamp(cached.stamp, stamp) || !await sources.current(stamp)) return null;
    return { completedAt: cached.completedAt, statistics: cached.statistics ?? null, error: cached.error,
      ...(cached.pendingFileInfo === undefined ? {} : { pendingFileInfo: cached.pendingFileInfo }) };
  }
  const preparedEtags = new WeakMap<Extract<Target, { kind: 'file' }>, string>();
  async function describe(resolved: Resolved, content?: FileInfo): Promise<Description> {
    const { target, ...base } = resolved;
    if (target.kind !== 'file') return { ...base, kind: 'directory', etag: await digest([base.path, target]) };
    if (!content) throw new LibraryError('invalid_source', 'Source returned no file metadata');
    const prepared = target.info?.contentId === content.contentId && target.info.size === content.size && target.info.mediaType === content.mediaType;
    let etag = prepared ? preparedEtags.get(target) : undefined;
    if (etag === undefined) {
      etag = await digest([target.stamp.id, target.ref, content.contentId, content.size, content.mediaType]);
      if (prepared) preparedEtags.set(target, etag);
    }
    return { ...base, modifiedAt: content.modifiedAt ?? base.modifiedAt, kind: 'file', etag,
      handle: { stamp: target.stamp, fileRef: target.ref, content } };
  }
  const metadataError = (error: unknown) => error instanceof Error ? error : new Error('File metadata is unavailable');
  const files: FileView = {
    list: async (path, signal) => listResolved(await resolve(path, signal), signal),
    async stat(entry, signal): Promise<Description> {
      signal.throwIfAborted();
      const resolved = typeof entry === 'string' ? await resolve(entry, signal)
        : listedEntries.get(entry) ?? await resolve(entry.path, signal);
      const { target } = resolved;
      if ((target.kind === 'file' || target.kind === 'directory') && !await sources.current(target.stamp)) {
        throw new LibraryError('stale_call', 'Source changed before metadata request');
      }
      if (target.kind !== 'file') return describe(resolved);
      let content = target.info;
      if (content === undefined) {
        content = unwrap(await sources.stat(target.stamp.id, target.ref, signal)); assertInfo(content);
      }
      const description = await describe(resolved, content);
      if (!await sources.current(target.stamp)) throw new LibraryError('stale_call', 'Source changed during metadata request');
      signal.throwIfAborted(); return description;
    },
    async statMany(entries, signal) {
      signal.throwIfAborted();
      const results = new Map<ViewEntry, Description | Error>();
      const groups = new Map<string, MetadataGroup>();
      const stampKeys = new WeakMap<SourceStamp, string>();
      for (const entry of entries) {
        try {
          const resolved = listedEntries.get(entry) ?? await resolve(entry.path, signal);
          const { target } = resolved;
          if (target.kind !== 'file' && target.kind !== 'directory') { results.set(entry, await describe(resolved)); continue; }
          const stamp = target.stamp;
          let key = stampKeys.get(stamp);
          if (key === undefined) {
            key = JSON.stringify([stamp.id, stamp.pluginId, stamp.epoch, stamp.pluginRevision, stamp.pluginGeneration]);
            stampKeys.set(stamp, key);
          }
          const group = groups.get(key) ?? { stamp, entries: [] };
          group.entries.push([entry, resolved]); groups.set(key, group);
        } catch (error) { signal.throwIfAborted(); results.set(entry, metadataError(error)); }
      }
      const ready: MetadataGroup[] = [];
      for (const group of groups.values()) {
        try {
          if (!await sources.current(group.stamp)) throw new LibraryError('stale_call', 'Source changed before metadata request');
          ready.push(group);
        } catch (error) {
          signal.throwIfAborted();
          for (const [entry] of group.entries) results.set(entry, metadataError(error));
        }
      }
      for (const group of ready) {
        const pending = group.entries.find(([, item]) => item.target.kind === 'file'
          && item.target.info === undefined && item.target.deferredDirectory !== undefined);
        if (!pending || pending[1].target.kind !== 'file') continue;
        const operation = await refreshes.ensureFileInfo(group.stamp, pending[1].target.deferredDirectory!);
        if (options.execution === 'deferred') throw new PendingRefreshError(operation.operationId);
        await drain(operation, signal);
        // Preparation atomically publishes a new view. Resolve the original paths
        // again rather than retaining targets from the names-only snapshot.
        for (const [entry] of group.entries) listedEntries.delete(entry);
        return files.statMany(entries, signal);
      }
      for (const group of ready) for (const [entry, resolved] of group.entries) {
        signal.throwIfAborted();
        try {
          let content: FileInfo | undefined;
          if (resolved.target.kind === 'file') {
            content = resolved.target.info;
            if (content === undefined) {
              // Old plugins have no prepared metadata; preserve their original per-file invocation semantics.
              content = unwrap(await sources.stat(resolved.target.stamp.id, resolved.target.ref, signal)); assertInfo(content);
            }
          }
          results.set(entry, await describe(resolved, content));
        } catch (error) { signal.throwIfAborted(); results.set(entry, metadataError(error)); }
      }
      // Hashing and legacy calls are asynchronous: check every source after the entire batch completes.
      for (const group of ready) {
        try {
          if (!await sources.current(group.stamp)) throw new LibraryError('stale_call', 'Source changed during metadata request');
        } catch (error) {
          signal.throwIfAborted();
          for (const [entry] of group.entries) results.set(entry, metadataError(error));
        }
      }
      signal.throwIfAborted(); return results;
    },
    async open(file: FileDescription, range: ByteRange | undefined, signal: AbortSignal): Promise<ReadResult> {
      const { stamp, fileRef, content } = file.handle;
      if (!await sources.current(stamp)) throw new LibraryError('stale_call', 'Source changed before audio request');
      if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end >= content.size)) {
        throw new LibraryError('range_unsupported', 'Requested range is invalid');
      }
      const result = unwrap(await sources.open(stamp.id, fileRef, { expectedContentId: content.contentId, ...(range ? { range } : {}) }, signal));
      const reject = async (code: 'range_unsupported' | 'content_changed') => {
        await result.body.cancel().catch(() => {}); throw new LibraryError(code, 'Source returned a different content representation or byte range');
      };
      if (result.content.contentId !== content.contentId || result.content.size !== content.size || result.content.mediaType !== content.mediaType) return reject('content_changed');
      if (range ? result.servedRange?.start !== range.start || result.servedRange?.end !== range.end : result.servedRange !== null) return reject('range_unsupported');
      if (!await sources.current(stamp)) { await result.body.cancel().catch(() => {}); throw new LibraryError('stale_call', 'Source changed during audio request'); }
      return { ...result, body: verifiedStream(result.body, range ? range.end - range.start + 1 : content.size, signal) };
    }
  };
  return {
    files,
    refreshes,
    schedules,
    refreshInstance,
    directoryStatus: async (instanceId: string, directoryRef: string) => publishedStatus(await sources.view(instanceId), directoryRef),
    async browseDirectory(path: string, signal: AbortSignal) {
      const resolved = await resolve(path, signal);
      if (resolved.target.kind === 'source') resolved.target = await sourceDirectory(resolved.target, signal);
      const entries = await listResolved(resolved, signal);
      const status = resolved.target.kind === 'directory' ? await publishedStatus(resolved.target.stamp, resolved.target.ref) : null;
      return { entries, status, ...(resolved.target.kind === 'directory'
        ? { source: { instanceId: resolved.target.stamp.id, pluginId: resolved.target.stamp.pluginId, directoryRef: resolved.target.ref } } : {}) };
    },
    async contentSources(instanceId: string, signal: AbortSignal) {
      return (await rootsView(instanceId, signal)).entries.map(entry => {
        if (entry.target.kind !== 'directory') throw new LibraryError('invalid_source', 'Invalid root target');
        return { sourceId: entry.id, name: entry.name, directoryRef: entry.target.ref };
      });
    },
    layout: () => store.layout(),
    async defaultLayout(signal: AbortSignal): Promise<LayoutNode[]> {
      const instances = await children({ kind: 'instances' }, signal);
      const nodes: LayoutNode[] = [];
      for (const instance of instances.entries) {
        const roots = await children(instance.target, signal);
        nodes.push({ kind: 'group', id: crypto.randomUUID(), name: instance.pathName,
          children: roots.entries.map(root => ({ kind: 'source', id: crypto.randomUUID(), name: root.pathName,
            instanceId: instance.id, sourceId: root.id })) });
      }
      return nodes;
    },
    async saveLayout(expectedRevision: number, nodes: unknown) {
      const value = parseLayout(nodes);
      if (!await store.saveLayout(expectedRevision, value)) throw new LibraryError('conflict', 'Layout changed in another operation');
      return store.layout();
    },
    async refresh(instanceId: string, directoryRef: string | undefined, signal: AbortSignal) {
      const stamp = await sources.view(instanceId);
      return refresh(stamp, directoryRef === undefined ? { kind: 'roots', ref: '' } : { kind: 'directory', ref: directoryRef }, signal);
    }
  };
}
export type Library = ReturnType<typeof createLibrary>;
