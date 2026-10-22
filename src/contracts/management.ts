import type { AuthStep, Configuration, HostKind, Json, PluginFault, PluginManifest, Root } from '@musicfs/plugin-api';

/** JSON resources shared by the browser and HTTP boundary; no runtime or domain imports. */
export type Status = { host: HostKind; version: string };
export type PluginInstallation = { manifest: PluginManifest; revision: string; generation: number; status: 'active' | 'missing' };
export type PluginInspection = { manifest: PluginManifest; revision: string;
  compatibility: { host: HostKind; apiVersion: string; apiCompatible: boolean; hostCompatible: boolean } };
export type SourceInstance = { id: string; pluginId: string; name: string; config: Json; epoch: number };
export type SourceConfiguration = { configuration: Configuration; authentication: boolean; metadataRefresh?: boolean; statistics?: Record<string, string>; naming?: { fields: Record<string, string> } };
export type LayoutNode = { id: string; name: string } & (
  | { kind: 'group'; children: LayoutNode[] }
  | { kind: 'source'; instanceId: string; sourceId: string }
);
export type Layout = { revision: number; nodes: LayoutNode[] | null };
export type ViewEntry = { kind: 'file' | 'directory'; path: string; name: string; modifiedAt: string };
export type ContentSources = Root[];
export type DirectoryStatus = { completedAt: string; statistics: Record<string, number> | null; error: string | null; pendingFileInfo?: number };
export type DirectoryListing = { entries: ViewEntry[]; status: DirectoryStatus | null; source?: { instanceId: string; pluginId: string; directoryRef: string } };
export type Result<T> = { ok: true; value: T } | { ok: false; error: PluginFault };
export type Connection = { davPath: string; username: string; password: string };
export type AuthenticationSession = { operationId: string; step: AuthStep | null; error?: PluginFault };
export type AuthenticationAction = { kind: 'start' } | { kind: 'cancel'; operationId: string }
  | { kind: 'poll'; operationId: string; challengeId: string }
  | { kind: 'submit'; operationId: string; challengeId: string; input: Json };
