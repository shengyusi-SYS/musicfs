/** Browser-visible desktop mounting contract. Credentials only occur in input. */
export type MountInput = {
  name?: string;
  mountPoint: string;
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
  directoryCacheSeconds: number;
  fileCacheMaxMiB: number;
  fileCacheMaxAgeHours: number;
  source: { kind: 'local' } | { kind: 'remote'; url: string };
  state: 'starting' | 'mounted' | 'unmounting' | 'stopped' | 'error';
  error?: { code: string; message: string };
};

export type MountCacheSettings = { directoryCacheSeconds: number; fileCacheMaxMiB?: number; fileCacheMaxAgeHours?: number };

export interface MountManager {
  list(): Promise<MountView[]>;
  mount(input: MountInput): Promise<MountView>;
  remount(id: string): Promise<MountView>;
  unmount(id: string): Promise<MountView>;
  remove(id: string): Promise<void>;
  configureCache(id: string, settings: MountCacheSettings): Promise<MountView>;
  refresh(id: string): Promise<void>;
  refreshLocal(): Promise<void>;
  close(): Promise<void>;
}
