/** Serializable data exchanged between a source plugin and its host. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type HostKind = 'desktop' | 'worker';
export type ByteRange = { start: number; end: number };
/** statistics are additive, nonnegative integer counters for this page, never running totals. */
export type WorkProgress = { completed: number; total: number; unit: string };
export type Page<T> = { items: T[]; nextCursor?: string; statistics?: Record<string, number>; progress?: WorkProgress };
export type FieldError = { path: string; message: string };

export interface PluginManifest {
  formatVersion: 1;
  id: string;
  name: string;
  version: string;
  apiRange: string;
  hosts: Partial<Record<HostKind, string>>;
  configVersion: number;
  stateVersion: number;
  files: string[];
}

export interface PluginFault {
  kind: 'invalid_config' | 'needs_auth' | 'not_found' | 'unavailable'
    | 'rate_limited' | 'temporary' | 'not_supported' | 'content_changed';
  message: string;
  retryAfterSeconds?: number;
  fields?: FieldError[];
}

/** A renewed credential can be valid even when the subsequent operation fails. */
export type Outcome<T> = { nextPrivateState?: Json } & (
  | { ok: true; value: T }
  | { ok: false; error: PluginFault }
);

export interface Context {
  instanceId: string;
  config: Json;
  privateState: Json;
  signal: AbortSignal;
  fetch: typeof fetch;
  /** Optional host storage for small, serializable plugin data, isolated to this source revision. */
  cache?: PluginCache;
  /** Optional host work allowance for this invocation; plugins may checkpoint before starting more work. */
  workBudget?: { readonly remaining: number };
}

export interface PluginCache {
  /** undefined means missing or expired; a cached null is a valid value. */
  get(key: string): Promise<Json | undefined>;
  /** Optional batched lookup, aligned with input keys; missing/expired values remain undefined. */
  getMany?(keys: string[]): Promise<(Json | undefined)[]>;
  /** Omit expiresAt for immutable data needed by published file references. Times are Unix milliseconds. */
  put(key: string, value: Json, options?: { expiresAt?: number }): Promise<void>;
  /** Optional atomic batch with the same expiry and source-revision rules as put. */
  putMany?(items: { key: string; value: Json; expiresAt?: number }[]): Promise<void>;
}

export interface Configuration {
  schema: JsonObject;
  ui?: { order?: string[]; widgets?: Record<string, 'password' | 'textarea' | 'uri'> };
}

export type Entry =
  | { kind: 'directory'; entryId: string; name: string; directoryRef: string }
  | { kind: 'file'; entryId: string; name: string; fileRef: string;
      /** Complete metadata for these exact bytes, never a size hint or a temporary locator. */
      info?: FileInfo };
export type Root = { sourceId: string; name: string; directoryRef: string };
export type FileInfo = { contentId: string; size: number; mediaType: string;
  /** Optional ISO timestamp for this byte representation, independent of directory refresh time. */
  modifiedAt?: string };
export type ReadRequest = { expectedContentId: string; range?: ByteRange };
export type ReadResult = {
  content: FileInfo;
  servedRange: ByteRange | null;
  body: ReadableStream<Uint8Array>;
};

export type AuthAction =
  | { kind: 'start' }
  | { kind: 'poll'; challengeId: string }
  | { kind: 'submit'; challengeId: string; input: Json }
  | { kind: 'cancel'; challengeId: string };
export type AuthStep =
  | { kind: 'waiting'; challengeId: string; expiresAt: string; message: string; qrCode?: string; qrImage?: string; url?: string }
  | { kind: 'input'; challengeId: string; expiresAt: string; message: string; configuration: Configuration }
  | { kind: 'complete'; accountName?: string }
  | { kind: 'expired'; message: string }
  | { kind: 'cancelled' };

export interface SourcePlugin {
  configuration: Configuration;
  /** Optional display labels for counters reported by this plugin's pages. */
  statistics?: Record<string, string>;
  validateConfig(ctx: Context, candidate: Json): Promise<Outcome<Json>>;
  roots(ctx: Context, cursor?: string): Promise<Outcome<Page<Root>>>;
  list(ctx: Context, directory: string, cursor?: string): Promise<Outcome<Page<Entry>>>;
  stat(ctx: Context, file: string): Promise<Outcome<FileInfo>>;
  open(ctx: Context, file: string, request: ReadRequest): Promise<Outcome<ReadResult>>;
  authenticate?(ctx: Context, action: AuthAction): Promise<Outcome<AuthStep>>;
  /** Optional session maintenance. needed is local/pure; only renew holds an instance lease. */
  renewal?: {
    needed(ctx: Context): boolean | Promise<boolean>;
    renew(ctx: Context): Promise<Outcome<null>>;
  };
  /** Pure candidate conversions; the host validates and atomically activates their outputs. */
  migrateConfig?(input: { fromVersion: number; config: Json; state: Json }): Json;
  migrateState?(input: { fromVersion: number; state: Json; config: Json }): Json;
  /** Pure validation of the target state against its candidate configuration. */
  validateState?(input: { config: Json; state: Json }): boolean;
}
