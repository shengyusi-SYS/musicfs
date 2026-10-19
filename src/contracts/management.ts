import type { AuthStep, Configuration, HostKind, Json, PluginFault, PluginManifest, Root } from '@musicfs/plugin-api';

/** JSON resources shared by the browser and HTTP boundary; no runtime or domain imports. */
export type Status = { host: HostKind; version: string };
export type PluginInstallation = { manifest: PluginManifest; revision: string; generation: number; status: 'active' | 'missing' };
export type SourceInstance = { id: string; pluginId: string; name: string; config: Json; epoch: number };
export type SourceConfiguration = { configuration: Configuration; authentication: boolean; statistics?: Record<string, string> };
export type LayoutNode = { id: string; name: string } & (
  | { kind: 'group'; children: LayoutNode[] }
  | { kind: 'source'; instanceId: string; sourceId: string }
);
export type Layout = { revision: number; nodes: LayoutNode[] | null };
export type ViewEntry = { kind: 'file' | 'directory'; path: string; name: string; modifiedAt: string };
export type ContentSources = Root[];
export type DirectoryStatus = { completedAt: string; statistics: Record<string, number> | null };
export type Result<T> = { ok: true; value: T } | { ok: false; error: PluginFault };
export type Connection = { davPath: string; username: string; password: string };
export type AuthenticationSession = { operationId: string; step: AuthStep | null; error?: PluginFault };
export type AuthenticationAction = { kind: 'start' } | { kind: 'cancel'; operationId: string }
  | { kind: 'poll'; operationId: string; challengeId: string }
  | { kind: 'submit'; operationId: string; challengeId: string; input: Json };
