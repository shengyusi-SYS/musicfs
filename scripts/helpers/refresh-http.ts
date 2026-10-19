import assert from 'node:assert/strict';
import type { RefreshView } from '../../src/contracts/refreshes';
import type { ContentSources, DirectoryStatus, SourceInstance, ViewEntry } from '../../src/contracts/management';

type HttpResponse = { status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; body?: { cancel(): Promise<unknown> } | null };
type ReadOrStep = Pick<RequestInit, 'method' | 'headers'>;
type Dispatch<R extends HttpResponse> = (url: string, init?: ReadOrStep) => Promise<R>;
const active = (view: RefreshView) => view.status === 'queued' || view.status === 'running';
const endpoint = (origin: string, path: string) => /^https?:\/\//.test(origin) ? new URL(path, origin).href : path;

/** Each dispatch is a distinct HTTP request; never reintroduce a synchronous server loop. */
export async function driveRefresh<R extends HttpResponse>(dispatch: Dispatch<R>, view: RefreshView, origin: string, headers: HeadersInit): Promise<RefreshView> {
  const id = view.operationId;
  assert.equal(typeof id, 'string');
  for (let steps = 0; active(view); steps++) {
    assert(steps < 10_000, 'Refresh did not reach a terminal state within the probe budget');
    const previous = view;
    const response = await dispatch(endpoint(origin, `/api/refreshes/${encodeURIComponent(id)}/step`), { method: 'POST', headers });
    assert.equal(response.status, 200, 'Refresh step failed');
    view = await response.json() as RefreshView;
    assert.equal(view.operationId, id, 'A step must not switch to a different refresh operation');
    if (active(view) && view.status === previous.status && view.updatedAt === previous.updatedAt
      && view.current?.kind === previous.current?.kind && view.current?.directoryRef === previous.current?.directoryRef
      && view.current?.pages === previous.current?.pages && view.current?.entries === previous.current?.entries) await Bun.sleep(2_000);
  }
  assert.equal(view.status, 'completed', `Refresh ended as ${view.status}`);
  return view;
}

export async function completeRefresh<R extends HttpResponse>(dispatch: Dispatch<R>, accepted: R, origin: string, headers: HeadersInit): Promise<RefreshView> {
  assert.equal(accepted.status, 202, 'Starting a refresh must return acceptance, not a completed snapshot');
  const view = await accepted.json() as RefreshView;
  assert.equal(accepted.headers.get('X-MusicFS-Refresh'), view.operationId);
  return driveRefresh(dispatch, view, origin, headers);
}

/** Cold reads follow their existing operation; they never POST another start request. */
export async function requestReady<R extends HttpResponse>(dispatch: Dispatch<R>, url: string, init: ReadOrStep = {}, refreshHeaders: HeadersInit = init.headers ?? {}): Promise<R> {
  for (let reads = 0; reads < 1_000; reads++) {
    const response = await dispatch(url, init);
    const id = response.status === 503 ? response.headers.get('X-MusicFS-Refresh') : null;
    if (!id) return response;
    assert.equal(response.headers.get('Retry-After'), '2');
    await response.body?.cancel();
    const state = await dispatch(endpoint(url, `/api/refreshes/${encodeURIComponent(id)}`), { headers: refreshHeaders });
    assert.equal(state.status, 200, 'A pending read must refer to an existing operation');
    const view = await state.json() as RefreshView; assert.equal(view.operationId, id);
    await driveRefresh(dispatch, view, url, refreshHeaders);
  }
  throw new Error('Cold read exceeded its preparation budget');
}

/** Read published content through the default layout, rather than treating acceptance as content. */
export async function publishedDirectory<R extends HttpResponse>(dispatch: Dispatch<R>, origin: string, instanceId: string, directoryRef: string, headers: HeadersInit): Promise<{ entries: ViewEntry[]; status: DirectoryStatus | null }> {
  const instances = await dispatch(endpoint(origin, '/api/instances'), { headers }); assert.equal(instances.status, 200);
  const instance = (await instances.json() as SourceInstance[]).find(item => item.id === instanceId); assert(instance);
  const roots = await requestReady(dispatch, endpoint(origin, `/api/instances/${encodeURIComponent(instanceId)}/roots`), { headers }); assert.equal(roots.status, 200);
  const root = (await roots.json() as ContentSources).find(item => item.directoryRef === directoryRef); assert(root);
  const path = `/${instance.name}/${root.name}`;
  const listing = await requestReady(dispatch, endpoint(origin, `/api/library?path=${encodeURIComponent(path)}`), { headers }); assert.equal(listing.status, 200);
  const status = await dispatch(endpoint(origin, `/api/instances/${encodeURIComponent(instanceId)}/directory-status?directoryRef=${encodeURIComponent(directoryRef)}`), { headers }); assert.equal(status.status, 200);
  return { entries: await listing.json() as ViewEntry[], status: await status.json() as DirectoryStatus | null };
}
