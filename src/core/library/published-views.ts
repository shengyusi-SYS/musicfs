import { LRUCache } from 'lru-cache';
import type { SourceStamp } from '../sources';
import { nameEntries } from './names';
import { LibraryError, type LibraryStore, type Snapshot, type SnapshotKey } from './types';
import type { FileNamingPolicy } from '../../contracts/file-naming';

type Named<T> = T & { pathName: string };
export type NamedView<T> = { entries: Named<T>[]; byName: ReadonlyMap<string, Named<T>> };
type PublishedView<T> = NamedView<T> & { estimatedBytes: number };
export type PublishedViewLimits = { views: number; estimatedBytes: number };
type Load = { stamp: SourceStamp; key: SnapshotKey; snapshotId: string; snapshot?: Snapshot; fileNamingPolicy: FileNamingPolicy };
const originalNames: FileNamingPolicy = { mode: 'original' };
const stampKey = (stamp: SourceStamp) => JSON.stringify([stamp.id, stamp.pluginId, stamp.epoch, stamp.pluginRevision, stamp.pluginGeneration]);
const matches = (snapshot: Pick<Snapshot, 'stamp' | 'id'>, load: Load) => snapshot.id === load.snapshotId && stampKey(snapshot.stamp) === stampKey(load.stamp);

export async function namedView<T extends { id: string; name: string }>(entries: T[]): Promise<NamedView<T>> {
  const named = await nameEntries(entries);
  return { entries: named, byName: new Map(named.map(entry => [entry.pathName, entry])) };
}

/** Published identity is authoritative; the bounded in-memory index only avoids rebuilding its view. */
export function createPublishedViews<T extends { id: string; name: string }>(
  store: Pick<LibraryStore, 'snapshot' | 'snapshotHeader'>,
  ensure: (stamp: SourceStamp, key: SnapshotKey, signal: AbortSignal) => Promise<Snapshot>,
  project: (snapshot: Snapshot, key: SnapshotKey, policy: FileNamingPolicy) => T[],
  limits: PublishedViewLimits = { views: 32, estimatedBytes: 8 * 1024 * 1024 }
) {
  const cache = new LRUCache<string, PublishedView<T>, Load>({
    max: limits.views, maxSize: limits.estimatedBytes, ignoreFetchAbort: true,
    sizeCalculation: view => view.estimatedBytes,
    async fetchMethod(_key, _previous, { context }) {
      const snapshot = context.snapshot ?? (await store.snapshot(context.stamp.id, context.key))?.value;
      // A publication may have changed between the header and row reads. Retry using its new identity.
      if (!snapshot || !matches(snapshot, context)) return undefined;
      if (snapshot.kind !== context.key.kind) throw new LibraryError('invalid_source', 'Invalid published snapshot kind');
      const view = await namedView(project(snapshot, context.key, context.fileNamingPolicy));
      // Estimate publication strings plus child objects/Map slots; the raw snapshot is not retained.
      // This is a bound on the cache's accounting,
      // not an exact JavaScript heap measurement; oversized directories are usable without being retained.
      const estimatedBytes = Math.max(1, JSON.stringify(snapshot).length * 2
        + view.entries.reduce((size, entry) => size + 256 + entry.pathName.length * 2, 256));
      return { ...view, estimatedBytes };
    }
  });
  return {
    async get(stamp: SourceStamp, key: SnapshotKey, signal: AbortSignal): Promise<PublishedView<T>> {
      for (;;) {
        signal.throwIfAborted();
        const header = await store.snapshotHeader(stamp.id, key);
        const value = header && stampKey(header.stamp) === stampKey(stamp) ? undefined : await ensure(stamp, key, signal);
        const identity = value ?? header!;
        const presentation = value ? await store.snapshotHeader(stamp.id, key) : header;
        const fileNamingPolicy = key.kind === 'directory' ? presentation?.fileNamingPolicy ?? originalNames : originalNames;
        const context: Load = { stamp, key, snapshotId: identity.id, fileNamingPolicy, ...(value ? { snapshot: value } : {}) };
        const directoryKey = JSON.stringify([stamp.id, key.kind, key.ref]) + ':';
        const cacheKey = directoryKey + JSON.stringify([stampKey(stamp), identity.id, fileNamingPolicy]);
        // Retained callers can still use their old targets, but superseded
        // versions must not consume the budget or evict another directory.
        if (!cache.has(cacheKey)) for (const previous of cache.keys()) {
          if (previous.startsWith(directoryKey) && previous !== cacheKey) cache.delete(previous);
        }
        // Shared work reads local published data only. One cancelled HTTP caller must not abort another's lookup.
        const view = await cache.fetch(cacheKey, { context });
        signal.throwIfAborted();
        if (view) return view;
      }
    }
  };
}
