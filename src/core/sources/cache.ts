import type { Json, PluginCache } from '@musicfs/plugin-api';
import { SourceError, type SourceStamp } from './types';

type Stored<T> = T | Promise<T>;
export interface PluginCacheStore {
  cachedPluginData(source: SourceStamp, key: string, now: number): Stored<string | undefined>;
  cachePluginData(source: SourceStamp, key: string, document: string, expiresAt: number | null, now: number): Stored<boolean>;
}

/** Keep small data in the existing database, never credentials or complete audio buffers. */
export function pluginCache(store: PluginCacheStore, source: SourceStamp, signal: AbortSignal, now: () => number): PluginCache {
  const keyOf = (key: string) => {
    if (!key || key.length > 4096) throw new Error('Invalid plugin cache key');
    return key;
  };
  return {
    async get(key) {
      signal.throwIfAborted();
      const document = await store.cachedPluginData(source, keyOf(key), now());
      signal.throwIfAborted();
      return document === undefined ? undefined : JSON.parse(document) as Json;
    },
    async put(key, value, options) {
      signal.throwIfAborted();
      const document = JSON.stringify(value);
      // D1 limits a row to 2 MB; reserve room for the key and other columns.
      if (document === undefined || new TextEncoder().encode(document).byteLength > 1_048_576) throw new Error('Plugin cache value exceeds 1 MiB');
      const expiresAt = options?.expiresAt ?? null;
      if (expiresAt !== null && !Number.isSafeInteger(expiresAt)) throw new Error('Invalid plugin cache expiry');
      if (!await store.cachePluginData(source, keyOf(key), document, expiresAt, now())) throw new SourceError('stale_call', 'The source changed while preparing cached data');
      signal.throwIfAborted();
    }
  };
}
