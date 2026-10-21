import type { Json, PluginFault } from '@musicfs/plugin-api';
import type { Status, SourceInstance, PluginInstallation, PluginInspection, SourceConfiguration, ContentSources, DirectoryStatus, DirectoryListing, Layout, LayoutNode, ViewEntry, Result, Connection, AuthenticationAction, AuthenticationSession } from '../contracts/management';
import type { PluginChange } from '../contracts/plugin-changes';
import type { MountCacheSettings, MountCacheStatus, MountInput, MountView } from '../contracts/mounts';
import type { RefreshScope, RefreshView } from '../contracts/refreshes';
import type { DesktopNetworkSettings, DesktopNetworkView, DesktopPreferences, DesktopPreferencesView } from '../contracts/desktop';
import type { MountPrerequisitesView } from '../contracts/mount-prerequisites';
import type { DesktopHttpsView } from '../contracts/desktop-https';
import type { RefreshPolicy } from '../contracts/refresh-policy';
import type { ReadCacheSettings, ReadCacheStatus } from '../contracts/read-cache';
import type { ManagementAccess, ManagementTicket } from '../contracts/management-auth';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly detail: unknown) {
    const fault = typeof detail === 'object' && detail !== null && 'error' in detail && typeof detail.error === 'object' && detail.error !== null && 'message' in detail.error ? detail.error : detail;
    super(typeof fault === 'object' && fault !== null && 'message' in fault && typeof fault.message === 'string'
      ? fault.message : `请求失败（${status}）`);
  }
  get fault(): PluginFault | undefined {
    const detail = this.detail;
    if (typeof detail !== 'object' || detail === null) return;
    const fault = 'sourceError' in detail ? detail.sourceError : 'error' in detail ? detail.error : undefined;
    return typeof fault === 'object' && fault !== null && 'kind' in fault ? fault as PluginFault : undefined;
  }
  get code(): string | undefined {
    return typeof this.detail === 'object' && this.detail !== null && 'error' in this.detail && typeof this.detail.error === 'string'
      ? this.detail.error : undefined;
  }
  get refreshOperationId(): string | undefined {
    return this.code === 'refresh_pending' && typeof this.detail === 'object' && this.detail !== null
      && 'operationId' in this.detail && typeof this.detail.operationId === 'string' ? this.detail.operationId : undefined;
  }
}

export type AccessView = ManagementAccess;
export type AccessTicket = ManagementTicket;

export function createApi(token = '', fetcher: typeof fetch = fetch, onUnauthorized?: () => void) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetcher(`/api${path}`, { ...init, headers, cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) {
      if (response.status === 401 && !path.startsWith('/access')) onUnauthorized?.();
      const detail: unknown = await response.json().catch(() => null);
      throw new ApiError(response.status, detail);
    }
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }
  const json = (method: string, value: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  return {
    request,
    access: () => request<AccessView>('/access'),
    login: (username: string, password: string, rememberMe: boolean) => request<unknown>('/access/login', json('POST', { username, password, rememberMe })),
    bootstrap: (token: string) => request<unknown>('/access/bootstrap', json('POST', { token })),
    exchangeTicket: (ticket: string) => request<unknown>('/access/exchange', json('POST', { ticket })),
    logout: () => request<unknown>('/access/logout', { method: 'POST' }),
    saveAccount: (username: string, password: string) => request<AccessView>('/access/account', json('PUT', { username, password })),
    accessTicket: () => request<AccessTicket>('/access/ticket', { method: 'POST' }),
    status: (signal?: AbortSignal) => request<Status>('/status', signal ? { signal } : {}),
    instances: (signal?: AbortSignal) => request<SourceInstance[]>('/instances', signal ? { signal } : {}),
    plugins: (signal?: AbortSignal) => request<PluginInstallation[]>('/plugins', signal ? { signal } : {}),
    inspectPlugin: (file: File) => request<PluginInspection>('/plugins/inspect', { method: 'POST', body: file }),
    inspectPluginUrl: (url: string) => request<PluginInspection>('/plugins/inspect-url', json('POST', { url })),
    install: (file: File) => request<PluginInstallation | PluginChange>('/plugins', { method: 'POST', body: file }),
    installUrl: (url: string) => request<PluginInstallation | PluginChange>('/plugins/from-url', json('POST', { url })),
    removePlugin: (id: string) => request<void | PluginChange>(`/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    pluginChange: (id: string, signal: AbortSignal) => request<PluginChange>(`/plugin-changes/${encodeURIComponent(id)}`, { signal }),
    mounts: (signal: AbortSignal) => request<MountView[]>('/mounts', { signal }),
    mount: (input: MountInput) => request<MountView>('/mounts', json('POST', input)),
    remount: (id: string) => request<MountView>(`/mounts/${encodeURIComponent(id)}/mount`, { method: 'POST' }),
    unmount: (id: string) => request<MountView>(`/mounts/${encodeURIComponent(id)}/unmount`, { method: 'POST' }),
    removeMount: (id: string) => request<void>(`/mounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    renameMount: (id: string, name: string) => request<MountView>(`/mounts/${encodeURIComponent(id)}/name`, json('PUT', { name })),
    configureMountCache: (id: string, settings: MountCacheSettings) => request<MountView>(`/mounts/${encodeURIComponent(id)}/cache`, json('PUT', settings)),
    mountCacheStatus: (id: string, signal: AbortSignal) => request<MountCacheStatus>(`/mounts/${encodeURIComponent(id)}/cache`, { signal }),
    clearMountCache: (id: string) => request<MountView>(`/mounts/${encodeURIComponent(id)}/cache`, { method: 'DELETE' }),
    refreshMount: (id: string) => request<void>(`/mounts/${encodeURIComponent(id)}/cache/refresh`, { method: 'POST' }),
    configureMountAutoMount: (id: string, enabled: boolean) => request<MountView>(`/mounts/${encodeURIComponent(id)}/auto-mount`, json('PUT', { enabled })),
    desktopReadCache: (signal: AbortSignal) => request<ReadCacheStatus>('/desktop/read-cache', { signal }),
    configureDesktopReadCache: (settings: ReadCacheSettings) => request<ReadCacheStatus>('/desktop/read-cache', json('PUT', settings)),
    clearDesktopReadCache: () => request<ReadCacheStatus>('/desktop/read-cache', { method: 'DELETE' }),
    mountPrerequisites: (signal: AbortSignal) => request<MountPrerequisitesView>('/desktop/mount-prerequisites', { signal }),
    installWinFsp: () => request<MountPrerequisitesView>('/desktop/mount-prerequisites/install', { method: 'POST' }),
    desktopHttps: (signal: AbortSignal) => request<DesktopHttpsView>('/desktop/https', { signal }),
    enableDesktopHttps: () => request<DesktopHttpsView>('/desktop/https/enable', { method: 'POST' }),
    trustDesktopHttps: () => request<DesktopHttpsView>('/desktop/https/trust', { method: 'POST' }),
    restoreWebDavFileSizeLimit: () => request<DesktopHttpsView>('/desktop/https/file-size-limit', { method: 'DELETE' }),
    disableDesktopHttps: () => request<DesktopHttpsView>('/desktop/https', { method: 'DELETE' }),
    quitDesktop: () => request<{ stopping: true }>('/desktop/quit', { method: 'POST' }),
    desktopNetwork: (signal: AbortSignal) => request<DesktopNetworkView>('/desktop/network', { signal }),
    saveDesktopNetwork: (settings: DesktopNetworkSettings) => request<DesktopNetworkView>('/desktop/network', json('PUT', settings)),
    desktopPreferences: (signal?: AbortSignal) => request<DesktopPreferencesView>('/desktop/preferences', signal ? { signal } : {}),
    saveDesktopPreferences: (settings: DesktopPreferences) => request<DesktopPreferencesView>('/desktop/preferences', json('PUT', settings)),
    configuration: (id: string, signal: AbortSignal) => request<SourceConfiguration>(`/plugins/${encodeURIComponent(id)}/configuration`, { signal }),
    createInstance: (pluginId: string, name: string, config: Json) => request<Result<SourceInstance>>('/instances', json('POST', { pluginId, name, config })),
    configure: (id: string, config: Json) => request<Result<Json>>(`/instances/${encodeURIComponent(id)}/config`, json('PUT', { config })),
    deleteInstance: (id: string) => request<void>(`/instances/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    logoutInstance: (id: string) => request<void>(`/instances/${encodeURIComponent(id)}/session`, { method: 'DELETE' }),
    roots: (id: string, signal: AbortSignal) => request<ContentSources>(`/instances/${encodeURIComponent(id)}/roots`, { signal }),
    directoryStatus: (id: string, ref: string, signal: AbortSignal) => request<DirectoryStatus | null>(`/instances/${encodeURIComponent(id)}/directory-status?directoryRef=${encodeURIComponent(ref)}`, { signal }),
    startRefresh: (id: string, scope: RefreshScope) => request<RefreshView>(`/instances/${encodeURIComponent(id)}/refresh`, json('POST', scope.kind === 'instance' ? { scope: 'instance' }
      : scope.kind === 'file-info' ? { scope: 'file-info', directoryRef: scope.directoryRef }
      : scope.directoryRef === undefined ? {} : { directoryRef: scope.directoryRef })),
    currentRefresh: (id: string, signal: AbortSignal) => request<RefreshView | null>(`/instances/${encodeURIComponent(id)}/refresh`, { signal }),
    refreshPolicy: (id: string, directoryRef: string | undefined, signal: AbortSignal) => request<RefreshPolicy>(`/instances/${encodeURIComponent(id)}/refresh-policy${directoryRef === undefined ? '' : '?directoryRef=' + encodeURIComponent(directoryRef)}`, { signal }),
    saveRefreshPolicy: (id: string, intervalMinutes: number, directoryRef?: string) => request<RefreshPolicy>(`/instances/${encodeURIComponent(id)}/refresh-policy${directoryRef === undefined ? '' : '?directoryRef=' + encodeURIComponent(directoryRef)}`, json('PUT', { intervalMinutes })),
    refreshOperation: (id: string, signal: AbortSignal) => request<RefreshView>(`/refreshes/${encodeURIComponent(id)}`, { signal }),
    stepRefresh: (id: string, signal?: AbortSignal) => request<RefreshView>(`/refreshes/${encodeURIComponent(id)}/step`, { method: 'POST', ...(signal ? { signal } : {}) }),
    cancelRefresh: (id: string) => request<RefreshView>(`/refreshes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    layout: (signal: AbortSignal) => request<Layout>('/layout', { signal }),
    defaultLayout: (signal: AbortSignal) => request<LayoutNode[]>('/layout/default', { signal }),
    saveLayout: (expectedRevision: number, nodes: LayoutNode[] | null) => request<Layout>('/layout', json('PUT', { expectedRevision, nodes })),
    library: (path: string, signal: AbortSignal) => request<ViewEntry[]>(`/library?path=${encodeURIComponent(path)}`, { signal }),
    browseDirectory: (path: string, signal: AbortSignal) => request<DirectoryListing>(`/library/directory?path=${encodeURIComponent(path)}`, { signal }),
    connection: (signal: AbortSignal) => request<Connection>('/connection', { signal }),
    authentication: (id: string, signal: AbortSignal) => request<AuthenticationSession | null>(`/instances/${encodeURIComponent(id)}/authentication`, { signal }),
    authenticate: (id: string, action: AuthenticationAction, signal?: AbortSignal) => request<Result<AuthenticationSession>>(`/instances/${encodeURIComponent(id)}/authentication`, { ...json('POST', action), ...(signal ? { signal } : {}) })
  };
}
export type Api = ReturnType<typeof createApi>;
