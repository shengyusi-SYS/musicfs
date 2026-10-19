/** Serializable data exchanged between a source plugin and its host. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type HostKind = 'desktop' | 'worker';
export type ByteRange = { start: number; end: number };
/** statistics are additive, nonnegative integer counters for this page, never running totals. */
export type Page<T> = { items: T[]; nextCursor?: string; statistics?: Record<string, number> };
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
}

export interface Configuration {
  schema: JsonObject;
  ui?: { order?: string[]; widgets?: Record<string, 'password' | 'textarea' | 'uri'> };
}

export type Entry =
  | { kind: 'directory'; entryId: string; name: string; directoryRef: string }
  | { kind: 'file'; entryId: string; name: string; fileRef: string };
export type Root = { sourceId: string; name: string; directoryRef: string };
export type FileInfo = { contentId: string; size: number; mediaType: string };
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
  migrateState?(input: { fromVersion: number; state: Json }): Json;
}
