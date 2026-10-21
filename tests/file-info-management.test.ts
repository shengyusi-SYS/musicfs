import { afterEach, expect, test } from 'bun:test';
import type { SourcePlugin } from '@musicfs/plugin-api';
import { createExtensions } from '../src/core/extensions';
import { createManagementApi } from '../src/transport/http';
import { createApi } from '../src/web/api';
import { libraryFixture } from './helpers/library-fixture';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const signal = () => new AbortController().signal;

async function setup() {
  const calls: { directoryRef: string; required: boolean }[] = [];
  const info = { contentId: 'fixture-exact-content', size: 1234, mediaType: 'audio/flac' };
  const source: SourcePlugin = {
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, candidate) => ({ ok: true, value: candidate }),
    roots: async () => ({ ok: true, value: { items: [{ sourceId: 'songs', name: '歌曲', directoryRef: 'songs/收藏' }] } }),
    list: async (ctx, directoryRef) => {
      calls.push({ directoryRef, required: ctx.fileInfo === 'required' });
      return { ok: true, value: { items: [{ kind: 'file', entryId: 'song', name: 'song.flac', fileRef: 'song',
        ...(ctx.fileInfo === 'required' ? { info } : { deferredInfo: true }) }] } };
    },
    stat: async () => ({ ok: true, value: info }),
    open: async () => ({ ok: false, error: { kind: 'not_supported', message: 'Unused' } })
  };
  const fixture = await libraryFixture(source); cleanups.push(fixture.close);
  const installation = fixture.store.installations()[0]!;
  const extensions = createExtensions(fixture.store, async () => {});
  const http = createManagementApi({ host: 'desktop', adminToken: 'fixture-admin', sources: fixture.sources, library: fixture.library,
    extensions, remove: id => extensions.remove(id), maxPackageBytes: 1024, install: async () => installation });
  const fetcher = ((input, init) => http.request(new Request(new URL(String(input), 'http://fixture'), init))) as typeof fetch;
  return { ...fixture, calls, http, api: createApi('fixture-admin', fetcher) };
}

test('the Web API requests file preparation through the existing HTTP operation without refreshing the instance', async () => {
  const f = await setup();
  const directoryRef = 'songs/收藏';
  const listing = await f.api.startRefresh(f.id, { kind: 'directory', directoryRef });
  expect((await f.api.stepRefresh(listing.operationId)).status).toBe('completed');
  expect(f.calls).toEqual([{ directoryRef, required: false }]);
  expect(await f.api.directoryStatus(f.id, directoryRef, signal())).toMatchObject({ error: null, pendingFileInfo: 1 });

  const scope = { kind: 'file-info' as const, directoryRef };
  const queued = await f.api.startRefresh(f.id, scope);
  expect(queued).toMatchObject({ status: 'queued', scope });
  expect(f.calls).toHaveLength(1);
  expect(await f.api.currentRefresh(f.id, signal())).toMatchObject({ operationId: queued.operationId, scope });
  const completed = await f.api.stepRefresh(queued.operationId);
  expect(completed).toMatchObject({ status: 'completed', scope, refreshedDirectories: 1 });
  expect(f.calls).toEqual([{ directoryRef, required: false }, { directoryRef, required: true }]);
  expect((await f.api.directoryStatus(f.id, directoryRef, signal()))?.pendingFileInfo ?? 0).toBe(0);

  const next = await f.api.startRefresh(f.id, scope);
  expect(await f.api.cancelRefresh(next.operationId)).toMatchObject({ status: 'cancelled', scope });
  expect((await f.api.stepRefresh(next.operationId)).status).toBe('cancelled');
  expect(f.calls).toHaveLength(2);
});

test('file preparation requires a directory and rejects mixed refresh request shapes', async () => {
  const f = await setup();
  for (const value of [{ scope: 'file-info' }, { scope: 'file-info', directoryRef: 'songs', extra: true },
    { scope: 'instance', directoryRef: 'songs' }]) {
    const response = await f.http.request(`/api/instances/${f.id}/refresh`, { method: 'POST',
      headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    expect(response.status).toBe(400);
  }
  expect(f.calls).toEqual([]);
});
