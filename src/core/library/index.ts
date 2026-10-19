import { z } from 'zod';
import type { ByteRange, Entry, FileInfo, Outcome, Page, ReadResult, Root } from '@musicfs/plugin-api';
import type { Sources, SourceStamp } from '../sources';
import { nameEntries } from './names';
import { LibraryError, type Description, type FileDescription, type FileView, type LayoutNode,
  type DirectoryStatus, type InstanceRefresh, type LibraryStore, type Snapshot, type SnapshotKey, type ViewEntry } from './types';
export * from './types';

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
function assertInfo(info: FileInfo) {
  if (!info || !info.contentId || !Number.isSafeInteger(info.size) || info.size < 0
    || typeof info.mediaType !== 'string' || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(info.mediaType)) {
    throw new LibraryError('invalid_source', 'Source returned invalid file metadata');
  }
}
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
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
  | { kind: 'file'; stamp: SourceStamp; ref: string };
type Child = { id: string; name: string; target: Target; modifiedAt: string };
type Resolved = { target: Target; name: string; path: string; modifiedAt: string };

export function createLibrary(sources: Sources, store: LibraryStore, budgets: { pages: number; entries: number; directories?: number } = { pages: 1000, entries: 100_000 }) {
  async function refresh(stamp: SourceStamp, key: SnapshotKey, signal: AbortSignal): Promise<Snapshot> {
    const requestId = crypto.randomUUID();
    if (!await store.beginRefresh(stamp, key, requestId)) throw new LibraryError('stale_call', 'Source changed before refresh');
    try {
      const roots: Root[] = []; const entries: Entry[] = []; const cursors = new Set<string>(); const identities = new Set<string>();
      let cursor: string | undefined; const counters = new Map<string, number>(); let reportedStatistics = false;
      let counterKeys: string | undefined;
      for (let pageNumber = 0; ; pageNumber++) {
        signal.throwIfAborted();
        if (pageNumber >= budgets.pages) throw new LibraryError('invalid_source', 'Source pagination budget exceeded');
        const page: Page<Root> | Page<Entry> = key.kind === 'roots'
          ? unwrap(await sources.roots(stamp.id, signal, cursor))
          : unwrap(await sources.list(stamp.id, key.ref, signal, cursor));
        if (!Array.isArray(page.items)) throw new LibraryError('invalid_source', 'Source returned an invalid page');
        const keys = JSON.stringify(Object.keys(page.statistics ?? {}).sort());
        if (counterKeys !== undefined && counterKeys !== keys) throw new LibraryError('invalid_source', 'Source page counters changed during pagination');
        counterKeys = keys;
        if (page.statistics !== undefined) {
          const statistics = z.record(z.string().min(1).max(64), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).safeParse(page.statistics);
          if (!statistics.success || Object.keys(statistics.data).length > 100) throw new LibraryError('invalid_source', 'Source returned invalid page counters');
          reportedStatistics = true;
          for (const [key, value] of Object.entries(statistics.data)) {
            const total = (counters.get(key) ?? 0) + value;
            if (!Number.isSafeInteger(total)) throw new LibraryError('invalid_source', 'Source counter total overflowed');
            counters.set(key, total);
          }
        }
        for (const item of page.items) {
          const identity = 'sourceId' in item ? item.sourceId : item.entryId;
          if (!identity || typeof item.name !== 'string' || identities.has(identity)) throw new LibraryError('invalid_source', 'Source repeated a directory occurrence identity');
          identities.add(identity);
          if (identities.size > budgets.entries) throw new LibraryError('invalid_source', 'Source entry budget exceeded');
          if (key.kind === 'roots' && 'sourceId' in item && typeof item.directoryRef === 'string') roots.push(item);
          else if (key.kind === 'directory' && 'entryId' in item
            && (item.kind === 'file' && typeof item.fileRef === 'string' || item.kind === 'directory' && typeof item.directoryRef === 'string')) entries.push(item);
          else throw new LibraryError('invalid_source', 'Source returned an invalid directory entry');
        }
        if (page.nextCursor === undefined) break;
        if (typeof page.nextCursor !== 'string' || cursors.has(page.nextCursor)) throw new LibraryError('invalid_source', 'Source returned a cyclic page cursor');
        cursors.add(page.nextCursor); cursor = page.nextCursor;
      }
      signal.throwIfAborted();
      const common = { stamp, id: requestId, completedAt: new Date().toISOString(), ...(reportedStatistics ? { statistics: Object.fromEntries(counters) } : {}) };
      const snapshot: Snapshot = key.kind === 'roots' ? { ...common, kind: 'roots', items: roots } : { ...common, kind: 'directory', items: entries };
      if (!await store.publishSnapshot(stamp, key, requestId, snapshot)) throw new LibraryError('stale_call', 'Source or refresh changed before publication');
      return snapshot;
    } catch (error) {
      await store.failRefresh(stamp, key, requestId, error instanceof LibraryError ? error.sourceFault?.kind ?? error.code : 'source_failed');
      throw error;
    }
  }
  async function snapshot(stamp: SourceStamp, key: SnapshotKey, signal: AbortSignal): Promise<Snapshot> {
    const cached = await store.snapshot(stamp.id, key);
    if (cached?.value && sameStamp(cached.value.stamp, stamp)) return cached.value;
    return refresh(stamp, key, signal);
  }
  async function refreshInstance(instanceId: string, signal: AbortSignal): Promise<InstanceRefresh> {
    const stamp = await sources.view(instanceId);
    const known = new Set(await store.knownDirectoryRefs(instanceId));
    const roots = await refresh(stamp, { kind: 'roots', ref: '' }, signal);
    if (roots.kind !== 'roots') throw new LibraryError('invalid_source', 'Invalid root snapshot');
    const pending = roots.items.map(root => root.directoryRef); const seen = new Set<string>();
    const result: InstanceRefresh = { refreshedDirectories: 0, failures: [] };
    for (let index = 0; index < pending.length; index++) {
      signal.throwIfAborted();
      const ref = pending[index]!;
      if (seen.has(ref)) continue;
      if (seen.size >= (budgets.directories ?? 1000)) throw new LibraryError('invalid_source', 'Instance refresh directory budget exceeded');
      seen.add(ref);
      try {
        const value = await refresh(stamp, { kind: 'directory', ref }, signal);
        result.refreshedDirectories++;
        // Refresh reachable, previously visited children. New subtrees load on first browse.
        if (value.kind === 'directory') for (const item of value.items) {
          if (item.kind === 'directory' && known.has(item.directoryRef) && !seen.has(item.directoryRef)) pending.push(item.directoryRef);
        }
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof LibraryError) || error.code === 'stale_call') throw error;
        result.failures.push({ directoryRef: ref, error: { code: error.code, message: error.message,
          ...(error.sourceFault ? { sourceFault: error.sourceFault } : {}) } });
      }
    }
    if (!await sources.current(stamp)) throw new LibraryError('stale_call', 'Source changed during instance refresh');
    return result;
  }
  async function children(target: Target, signal: AbortSignal): Promise<Child[]> {
    if (target.kind === 'instances') return (await sources.instances()).map(instance => ({
      id: instance.id, name: instance.name, target: { kind: 'instance', instanceId: instance.id }, modifiedAt: epochDate
    }));
    if (target.kind === 'layout') return target.nodes.map(node => ({ id: node.id, name: node.name, modifiedAt: epochDate,
      target: node.kind === 'group' ? { kind: 'layout', nodes: node.children, revision: target.revision }
        : { kind: 'source', instanceId: node.instanceId, sourceId: node.sourceId } }));
    if (target.kind === 'instance' || target.kind === 'source') {
      const stamp = await sources.view(target.instanceId);
      const value = await snapshot(stamp, { kind: 'roots', ref: '' }, signal);
      if (value.kind !== 'roots') throw new LibraryError('invalid_source', 'Invalid root snapshot');
      if (target.kind === 'source') {
        const root = value.items.find(item => item.sourceId === target.sourceId);
        if (!root) throw new LibraryError('not_found', 'Content source no longer exists');
        return children({ kind: 'directory', stamp, ref: root.directoryRef }, signal);
      }
      return value.items.map(root => ({ id: root.sourceId, name: root.name, modifiedAt: value.completedAt,
        target: { kind: 'directory', stamp, ref: root.directoryRef } }));
    }
    if (target.kind !== 'directory') throw new LibraryError('not_directory', 'Path is not a directory');
    if (!await sources.current(target.stamp)) throw new LibraryError('stale_call', 'Source changed');
    const value = await snapshot(target.stamp, { kind: 'directory', ref: target.ref }, signal);
    if (value.kind !== 'directory') throw new LibraryError('invalid_source', 'Invalid directory snapshot');
    return value.items.map(entry => ({ id: entry.entryId, name: entry.name, modifiedAt: value.completedAt,
      target: entry.kind === 'directory' ? { kind: 'directory', stamp: target.stamp, ref: entry.directoryRef }
        : { kind: 'file', stamp: target.stamp, ref: entry.fileRef } }));
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
      const entries = await nameEntries(await children(target, signal));
      const next = entries.find(entry => entry.pathName === segment);
      if (!next) throw new LibraryError('not_found', 'Export path not found');
      target = next.target; name = next.pathName; canonical += `/${name}`; modifiedAt = next.modifiedAt;
    }
    return { target, name, path: canonical || '/', modifiedAt };
  }
  // A listed entry keeps its resolved target only while its caller retains that object.
  // Serialized or externally created entries still resolve through the ordinary path boundary.
  const listedEntries = new WeakMap<ViewEntry, Resolved>();
  const files: FileView = {
    async list(path, signal): Promise<ViewEntry[]> {
      const resolved = await resolve(path, signal);
      return (await nameEntries(await children(resolved.target, signal))).map(entry => {
        const view: ViewEntry = { kind: entry.target.kind === 'file' ? 'file' : 'directory', name: entry.pathName,
          path: `${resolved.path === '/' ? '' : resolved.path}/${entry.pathName}`, modifiedAt: entry.modifiedAt };
        listedEntries.set(view, { target: entry.target, name: view.name, path: view.path, modifiedAt: view.modifiedAt });
        return view;
      });
    },
    async stat(entry, signal): Promise<Description> {
      signal.throwIfAborted();
      const resolved = typeof entry === 'string' ? await resolve(entry, signal)
        : listedEntries.get(entry) ?? await resolve(entry.path, signal);
      const { target, ...base } = resolved;
      if ((target.kind === 'file' || target.kind === 'directory') && !await sources.current(target.stamp)) {
        throw new LibraryError('stale_call', 'Source changed before metadata request');
      }
      if (target.kind !== 'file') return { ...base, kind: 'directory', etag: await digest([base.path, target]) };
      const content = unwrap(await sources.stat(target.stamp.id, target.ref, signal)); assertInfo(content);
      if (!await sources.current(target.stamp)) throw new LibraryError('stale_call', 'Source changed during metadata request');
      return { ...base, kind: 'file', etag: await digest([target.stamp.id, target.ref, content]), handle: { stamp: target.stamp, fileRef: target.ref, content } };
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
    refreshInstance,
    async directoryStatus(instanceId: string, directoryRef: string): Promise<DirectoryStatus | null> {
      const stamp = await sources.view(instanceId);
      const cached = await store.snapshot(instanceId, { kind: 'directory', ref: directoryRef });
      if (!cached?.value || !sameStamp(cached.value.stamp, stamp) || !await sources.current(stamp)) return null;
      return { completedAt: cached.value.completedAt, statistics: cached.value.statistics ?? null };
    },
    async contentSources(instanceId: string, signal: AbortSignal) {
      const stamp = await sources.view(instanceId);
      const value = await snapshot(stamp, { kind: 'roots', ref: '' }, signal);
      if (value.kind !== 'roots') throw new LibraryError('invalid_source', 'Invalid root snapshot');
      return value.items;
    },
    layout: () => store.layout(),
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
