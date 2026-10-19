import type { Json, PluginFault } from '@musicfs/plugin-api';
import type { Status, SourceInstance, PluginInstallation, SourceConfiguration, ContentSources, DirectoryStatus, InstanceRefresh, Layout, LayoutNode, ViewEntry, Result, Connection, AuthenticationAction, AuthenticationSession } from '../contracts/management';

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
}

export function createApi(token: string, fetcher: typeof fetch = fetch) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetcher(`/api${path}`, { ...init, headers, cache: 'no-store' });
    if (!response.ok) {
      const detail: unknown = await response.json().catch(() => null);
      throw new ApiError(response.status, detail);
    }
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }
  const json = (method: string, value: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  return {
    request,
    status: (signal?: AbortSignal) => request<Status>('/status', signal ? { signal } : {}),
    instances: (signal?: AbortSignal) => request<SourceInstance[]>('/instances', signal ? { signal } : {}),
    plugins: (signal?: AbortSignal) => request<PluginInstallation[]>('/plugins', signal ? { signal } : {}),
    install: (file: File) => request<PluginInstallation>('/plugins', { method: 'POST', body: file }),
    installUrl: (url: string) => request<PluginInstallation>('/plugins/from-url', json('POST', { url })),
    removePlugin: (id: string) => request<void>(`/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    configuration: (id: string, signal: AbortSignal) => request<SourceConfiguration>(`/plugins/${encodeURIComponent(id)}/configuration`, { signal }),
    createInstance: (pluginId: string, name: string, config: Json) => request<Result<SourceInstance>>('/instances', json('POST', { pluginId, name, config })),
    configure: (id: string, config: Json) => request<Result<Json>>(`/instances/${encodeURIComponent(id)}/config`, json('PUT', { config })),
    deleteInstance: (id: string) => request<void>(`/instances/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    roots: (id: string, signal: AbortSignal) => request<ContentSources>(`/instances/${encodeURIComponent(id)}/roots`, { signal }),
    directoryStatus: (id: string, ref: string, signal: AbortSignal) => request<DirectoryStatus | null>(`/instances/${encodeURIComponent(id)}/directory-status?directoryRef=${encodeURIComponent(ref)}`, { signal }),
    refresh: (id: string) => request<InstanceRefresh>(`/instances/${encodeURIComponent(id)}/refresh`, json('POST', { scope: 'instance' })),
    refreshDirectory: (id: string, directoryRef: string) => request<unknown>(`/instances/${encodeURIComponent(id)}/refresh`, json('POST', { directoryRef })),
    layout: (signal: AbortSignal) => request<Layout>('/layout', { signal }),
    saveLayout: (expectedRevision: number, nodes: LayoutNode[] | null) => request<Layout>('/layout', json('PUT', { expectedRevision, nodes })),
    library: (path: string, signal: AbortSignal) => request<ViewEntry[]>(`/library?path=${encodeURIComponent(path)}`, { signal }),
    connection: (signal: AbortSignal) => request<Connection>('/connection', { signal }),
    authentication: (id: string, signal: AbortSignal) => request<AuthenticationSession | null>(`/instances/${encodeURIComponent(id)}/authentication`, { signal }),
    authenticate: (id: string, action: AuthenticationAction, signal?: AbortSignal) => request<Result<AuthenticationSession>>(`/instances/${encodeURIComponent(id)}/authentication`, { ...json('POST', action), ...(signal ? { signal } : {}) })
  };
}
export type Api = ReturnType<typeof createApi>;
