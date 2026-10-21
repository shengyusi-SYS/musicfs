import type { Json, PluginCache } from '@musicfs/plugin-api';
import { SourceError, type SourceStamp } from './types';

type Stored<T> = T | Promise<T>;
export interface PluginCacheStore {
  cachedPluginData(source: SourceStamp, key: string, now: number): Stored<string | undefined>;
  cachedPluginDataMany?(source: SourceStamp, keys: string[], now: number): Stored<{ key: string; document: string }[]>;
  cachePluginData(source: SourceStamp, key: string, document: string, expiresAt: number | null, now: number, cleanup?: boolean): Stored<boolean>;
  cachePluginDataMany?(source: SourceStamp, items: { key: string; document: string; expiresAt: number | null }[], now: number, cleanup?: boolean): Stored<boolean>;
  cachePluginDataIfAbsent?(source: SourceStamp, key: string, document: string, now: number, cleanup?: boolean): Stored<string | undefined>;
}

/** Keep small data in the existing database, never credentials or complete audio buffers. */
export function pluginCache(store: PluginCacheStore, source: SourceStamp, signal: AbortSignal, now: () => number, spend: (amount: number) => void = () => {}): PluginCache {
  let cleaned = false;
  const cleanup = () => { const first = !cleaned; cleaned = true; return first; };
  const keyOf = (key: string) => {
    if (!key || key.length > 4096) throw new Error('Invalid plugin cache key');
    return key;
  };
  const dataOf = (key: string, value: Json, expiresAt: number | null) => {
    keyOf(key); const document = JSON.stringify(value);
    if (document === undefined || new TextEncoder().encode(document).byteLength > 1_048_576) throw new Error('Plugin cache value exceeds 1 MiB');
    if (expiresAt !== null && !Number.isSafeInteger(expiresAt)) throw new Error('Invalid plugin cache expiry');
    return { key, document, expiresAt };
  };
  return {
    async get(key) {
      signal.throwIfAborted();
      spend(1);
      const document = await store.cachedPluginData(source, keyOf(key), now());
      signal.throwIfAborted();
      return document === undefined ? undefined : JSON.parse(document) as Json;
    },
    async getMany(keys) {
      signal.throwIfAborted(); keys.forEach(keyOf);
      if (!keys.length) return [];
      spend(store.cachedPluginDataMany ? 1 : keys.length);
      const documents = store.cachedPluginDataMany ? await store.cachedPluginDataMany(source, keys, now())
        : await Promise.all(keys.map(async key => ({ key, document: await store.cachedPluginData(source, key, now()) })));
      signal.throwIfAborted();
      const values = new Map(documents.map(item => [item.key, item.document]));
      return keys.map(key => { const document = values.get(key); return document === undefined ? undefined : JSON.parse(document) as Json; });
    },
    async put(key, value, options) {
      signal.throwIfAborted();
      const { document, expiresAt } = dataOf(key, value, options?.expiresAt ?? null);
      // Both current SQL adapters execute cleanup + conditional upsert.
      const clean = cleanup(); spend(clean ? 2 : 1);
      if (!await store.cachePluginData(source, keyOf(key), document, expiresAt, now(), clean)) throw new SourceError('stale_call', 'The source changed while preparing cached data');
      signal.throwIfAborted();
    },
    ...(store.cachePluginDataIfAbsent ? { async putIfAbsent(key: string, value: Json) {
      signal.throwIfAborted();
      const { document } = dataOf(key, value, null);
      // Conditional insert and winner lookup share one transaction/batch.
      const clean = cleanup(); spend(clean ? 3 : 2);
      const winner = await store.cachePluginDataIfAbsent!(source, key, document, now(), clean);
      if (winner === undefined) throw new SourceError('stale_call', 'The source changed while preparing cached data');
      signal.throwIfAborted();
      return JSON.parse(winner) as Json;
    } } : {}),
    ...(store.cachePluginDataMany ? { async putMany(items: { key: string; value: Json; expiresAt?: number }[]) {
      signal.throwIfAborted();
      const rows = [...new Map(items.map(item => [item.key, dataOf(item.key, item.value, item.expiresAt ?? null)])).values()];
      if (!rows.length) return;
      const clean = cleanup(); spend(clean ? 2 : 1);
      const written = await store.cachePluginDataMany!(source, rows, now(), clean);
      if (!written) throw new SourceError('stale_call', 'The source changed while preparing cached data');
      signal.throwIfAborted();
    } } : {})
  };
}
