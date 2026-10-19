import type { ByteRange, Entry, FileInfo, PluginFault, ReadResult, Root } from '@musicfs/plugin-api';
import type { SourceStamp } from '../sources';

export type LayoutNode = { id: string; name: string } & (
  | { kind: 'group'; children: LayoutNode[] }
  | { kind: 'source'; instanceId: string; sourceId: string }
);
export type Layout = { revision: number; nodes: LayoutNode[] | null };
export type SnapshotKey = { kind: 'roots' | 'directory'; ref: string };
export type Snapshot = { stamp: SourceStamp; id: string; completedAt: string; statistics?: Record<string, number> } & (
  | { kind: 'roots'; items: Root[] }
  | { kind: 'directory'; items: Entry[] }
);
export type DirectoryStatus = { completedAt: string; statistics: Record<string, number> | null };
export type InstanceRefresh = { refreshedDirectories: number; failures: { directoryRef: string; error: { code: string; message: string; sourceFault?: PluginFault } }[] };
type Stored<T> = T | Promise<T>;
export interface LibraryStore {
  layout(): Stored<Layout>;
  saveLayout(expectedRevision: number, nodes: LayoutNode[] | null): Stored<boolean>;
  snapshot(instanceId: string, key: SnapshotKey): Stored<{ value: Snapshot | null; error: string | null } | undefined>;
  knownDirectoryRefs(instanceId: string): Stored<string[]>;
  beginRefresh(stamp: SourceStamp, key: SnapshotKey, requestId: string): Stored<boolean>;
  publishSnapshot(stamp: SourceStamp, key: SnapshotKey, requestId: string, value: Snapshot): Stored<boolean>;
  failRefresh(stamp: SourceStamp, key: SnapshotKey, requestId: string, error: string): Stored<void>;
}

export type DirectoryInfo = { kind: 'directory'; path: string; name: string; etag: string; modifiedAt: string };
export type FileHandle = { stamp: SourceStamp; fileRef: string; content: FileInfo };
export type FileDescription = { kind: 'file'; path: string; name: string; etag: string; modifiedAt: string; handle: FileHandle };
export type Description = DirectoryInfo | FileDescription;
export type ViewEntry = Pick<Description, 'kind' | 'path' | 'name' | 'modifiedAt'>;

/** The DAV adapter consumes this Interface and knows no source/platform semantics. */
export interface FileView {
  list(path: string, signal: AbortSignal): Promise<ViewEntry[]>;
  stat(path: string, signal: AbortSignal): Promise<Description>;
  open(file: FileDescription, range: ByteRange | undefined, signal: AbortSignal): Promise<ReadResult>;
}

export class LibraryError extends Error {
  constructor(public readonly code: 'not_found' | 'not_directory' | 'invalid_layout' | 'conflict' | 'stale_call'
    | 'source_failed' | 'invalid_source' | 'range_unsupported' | 'content_changed', message: string, public readonly sourceFault?: PluginFault) {
    super(message); this.name = 'LibraryError';
  }
}
