import type { ByteRange, Entry, FileInfo, PluginFault, ReadResult, Root } from '@musicfs/plugin-api';
import type { SourceStamp } from '../sources';
import type { FileNamingPolicy } from '../../contracts/file-naming';

export type LayoutNode = { id: string; name: string } & (
  | { kind: 'group'; children: LayoutNode[] }
  | { kind: 'source'; instanceId: string; sourceId: string; directoryRef?: string | undefined }
);
export type Layout = { revision: number; nodes: LayoutNode[] | null };
export type SnapshotKey = { kind: 'roots' | 'directory'; ref: string };
/** id identifies published content; completedAt records the latest successful check. */
export type Snapshot = { stamp: SourceStamp; id: string; completedAt: string; contentModifiedAt?: string; statistics?: Record<string, number>; pendingFileInfo?: number } & (
  | { kind: 'roots'; items: Root[] }
  | { kind: 'directory'; items: Entry[] }
);
export type DirectoryStatus = { completedAt: string; statistics: Record<string, number> | null; error: string | null; pendingFileInfo?: number };
/** Display settings travel with the existing header query, never with immutable source snapshots. */
export type PublishedHeader = Omit<Snapshot, 'items'> & { error: string | null; fileNamingPolicy?: FileNamingPolicy };
export type InstanceRefresh = { refreshedDirectories: number; failures: { directoryRef: string; error: { code: string; message: string; sourceFault?: PluginFault } }[] };
type Stored<T> = T | Promise<T>;
export interface LibraryStore {
  layout(): Stored<Layout>;
  saveLayout(expectedRevision: number, nodes: LayoutNode[] | null): Stored<boolean>;
  snapshot(instanceId: string, key: SnapshotKey): Stored<{ value: Snapshot | null; error: string | null } | undefined>;
  snapshotHeader(instanceId: string, key: SnapshotKey): Stored<PublishedHeader | null>;
  knownDirectoryRefs(instanceId: string): Stored<string[]>;
  /** Management preview only: select one already published file directory without warming a source. */
  fileNamingPreviewDirectory?(instanceId: string): Stored<string | null>;
}

export type DirectoryInfo = { kind: 'directory'; path: string; name: string; etag: string; modifiedAt: string };
export type FileHandle = { stamp: SourceStamp; fileRef: string; content: FileInfo };
export type FileDescription = { kind: 'file'; path: string; name: string; etag: string; modifiedAt: string; handle: FileHandle };
export type Description = DirectoryInfo | FileDescription;
export type ViewEntry = Pick<Description, 'kind' | 'path' | 'name' | 'modifiedAt'>;

/** The DAV adapter consumes this Interface and knows no source/platform semantics. */
export interface FileView {
  list(path: string, signal: AbortSignal): Promise<ViewEntry[]>;
  stat(entry: string | ViewEntry, signal: AbortSignal): Promise<Description>;
  /** Complete info is reused. Opt-in deferred entries may start a durable preparation; legacy stat remains live. */
  statMany(entries: readonly ViewEntry[], signal: AbortSignal): Promise<ReadonlyMap<ViewEntry, Description | Error>>;
  open(file: FileDescription, range: ByteRange | undefined, signal: AbortSignal): Promise<ReadResult>;
}

export class LibraryError extends Error {
  constructor(public readonly code: 'not_found' | 'not_directory' | 'invalid_layout' | 'conflict' | 'stale_call'
    | 'source_failed' | 'invalid_source' | 'range_unsupported' | 'content_changed' | 'refresh_pending', message: string, public readonly sourceFault?: PluginFault) {
    super(message); this.name = 'LibraryError';
  }
}

export class PendingRefreshError extends LibraryError {
  constructor(public readonly operationId: string) {
    super('refresh_pending', '目录正在准备，请稍后重试。');
  }
}
