/** Browser-visible desktop mounting contract. Credentials only occur in input. */
export type MountInput = {
  /** Display name and native volume label; defaults to MusicFS. */
  name?: string;
  mountPoint: string;
  /** Restore this saved mount when the desktop starts; defaults to true. */
  autoMount?: boolean;
  /** Directory listing lifetime; zero keeps listings until explicitly refreshed. */
  directoryCacheSeconds?: number;
  /** Per-mount soft disk limit for read fragments; zero disables new caching. */
  fileCacheMaxMiB?: number;
  /** Evict cache entries after this many hours without access; zero disables age eviction. */
  fileCacheMaxAgeHours?: number;
  source: { kind: 'local' } | { kind: 'remote'; url: string; username: string; password: string };
};

export type MountView = {
  id: string;
  name: string;
  mountPoint: string;
  autoMount: boolean;
  directoryCacheSeconds: number;
  fileCacheMaxMiB: number;
  fileCacheMaxAgeHours: number;
  source: { kind: 'local' } | { kind: 'remote'; url: string };
  state: 'starting' | 'mounted' | 'unmounting' | 'stopped' | 'error';
  error?: { code: string; message: string };
};

export type MountCacheSettings = { directoryCacheSeconds: number; fileCacheMaxMiB?: number; fileCacheMaxAgeHours?: number };

export type MountCacheStatus = {
  mountId: string;
  configuredMode: 'off' | 'full';
  actualMode: 'off' | 'minimal' | 'writes' | 'full' | null;
  directory: string;
  state: 'active' | 'inactive' | 'unavailable';
  /** Native VFS samples, not a live filesystem scan; null when no VFS is active. */
  bytesUsed: number | null;
  files: number | null;
  sampledAt: string;
  message: string | null;
};

export interface MountManager {
  list(): Promise<MountView[]>;
  mount(input: MountInput): Promise<MountView>;
  remount(id: string): Promise<MountView>;
  unmount(id: string): Promise<MountView>;
  remove(id: string): Promise<void>;
  rename(id: string, name: string): Promise<MountView>;
  configureAutoMount(id: string, enabled: boolean): Promise<MountView>;
  configureCache(id: string, settings: MountCacheSettings): Promise<MountView>;
  cacheStatus(id: string): Promise<MountCacheStatus>;
  clearCache(id: string): Promise<MountView>;
  refresh(id: string): Promise<void>;
  /** Omitted paths refresh all listings; otherwise invalidate only these visible folders. */
  refreshLocal(paths?: readonly string[]): Promise<void>;
  close(): Promise<void>;
}
