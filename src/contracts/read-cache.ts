/** Desktop DAV cache, shared by direct readers and separate from per-mount caches. */
export type ReadCacheSettings = {
  /** Soft disk limit in MiB; zero disables new caching. */
  maxMiB: number;
  /** Evict entries after this many hours without access; zero disables age eviction. */
  maxAgeHours: number;
};

export type ReadCacheStatus = {
  settings: ReadCacheSettings;
  actualMode: 'off' | 'full' | null;
  state: 'inactive' | 'active' | 'unavailable';
  directory: string;
  /** Native VFS samples may lag; null when no VFS is active. */
  bytesUsed: number | null;
  files: number | null;
  sampledAt: string;
  message: string | null;
};

export interface ReadCacheManager {
  inspect(): Promise<ReadCacheStatus>;
  configure(settings: ReadCacheSettings): Promise<ReadCacheStatus>;
  clear(): Promise<ReadCacheStatus>;
}
