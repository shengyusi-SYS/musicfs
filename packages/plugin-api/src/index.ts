/** Serializable data exchanged between a source plugin and its host. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type HostKind = 'desktop' | 'worker';
export type ByteRange = { start: number; end: number };
/** statistics are additive, nonnegative integer counters for this page, never running totals. */
export type WorkProgress = { completed: number; total: number; unit: string };
export type Page<T> = { items: T[]; nextCursor?: string; statistics?: Record<string, number>; progress?: WorkProgress };
export type MessageTranslation = { key: string; values?: Record<string, string | number> };
export type DisplayMessage = { message: string; translation?: MessageTranslation | undefined };
export type FieldError = DisplayMessage & { path: string };

export interface PluginManifest {
  formatVersion: 1;
  id: string;
  name: string;
  /** Optional localized plugin names; instance names and filesystem paths remain user data. */
  nameTranslations?: Record<string, string>;
  version: string;
  apiRange: string;
  hosts: Partial<Record<HostKind, string>>;
  configVersion: number;
  stateVersion: number;
  files: string[];
}

export interface PluginFault extends DisplayMessage {
  kind: 'invalid_config' | 'needs_auth' | 'not_found' | 'unavailable'
    | 'rate_limited' | 'temporary' | 'not_supported' | 'content_changed';
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
  /** On a preparation pass, list must return exact info for each file, or an explicit fault. */
  fileInfo?: 'required';
  /** Explicit metadata refresh operation; reuse fresh assets within this ID, never overwrite published plans. */
  metadataRefresh?: string;
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
  /** Atomically store without expiry if missing/expired; otherwise return the existing winner, including null. */
  putIfAbsent?(key: string, value: Json): Promise<Json>;
}

export interface Configuration {
  schema: JsonObject;
  /** Optional plugin-owned display translations, keyed by BCP 47 language and original message. */
  translations?: Record<string, Record<string, string>>;
  ui?: { order?: string[]; widgets?: Record<string, 'password' | 'textarea' | 'uri'> };
}

/** Optional display facts obtained during listing, independent of fileRef and audio bytes.
 * Conventional music fields: title, artist (string[]), album, albumArtist (string[]),
 * track, disc, index (one-based directory order), quality, id. Other sources may declare their own fields.
 */
export type FileNamingFacts = { identity: string; fields: Record<string, string | number | string[]> };

export type Entry =
  | { kind: 'directory'; entryId: string; name: string; directoryRef: string }
  | { kind: 'file'; entryId: string; name: string; fileRef: string;
      /** Complete metadata for these exact bytes, never a size hint or a temporary locator. */
      info?: FileInfo;
      /** identity excludes global directory position; repeated occurrences are allocated by the host. */
      naming?: FileNamingFacts;
      /** Opt in to background preparation for bulk attributes. Single stat/open still resolve this file on demand. */
      deferredInfo?: true };
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
  /** Pure identity of config fields that affect content/authentication. Omit retention policy only. */
  contentConfiguration?(config: Json): Json;
  /** Understands Context.metadataRefresh for deliberate, paged refreshes of music metadata. */
  metadataRefresh?: true;
  /** Optional display labels for counters reported by this plugin's pages. */
  statistics?: Record<string, string>;
  /** Optional template field labels. Listing already owns these facts; naming must not fetch audio or extra metadata. */
  naming?: { fields: Record<string, string> };
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
