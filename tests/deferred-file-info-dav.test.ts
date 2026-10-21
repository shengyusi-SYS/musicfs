import { expect, test } from 'bun:test';
import type { Entry, SourcePlugin } from '@musicfs/plugin-api';
import { createLibrary } from '../src/core/library';
import { createDav } from '../src/transport/dav';
import { libraryFixture } from './helpers/library-fixture';

const signal = () => new AbortController().signal;
const path = '/实例 & #/来源';
const url = 'http://fixture/dav/' + ['实例 & #', '来源'].map(encodeURIComponent).join('/');
const authorization = 'Basic ' + btoa('reader:password');
const info = (file: string) => ({ contentId: file, size: 8, mediaType: 'audio/wav', modifiedAt: '2026-10-20T00:00:00.000Z' });
const names = '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:resourcetype/></D:prop></D:propfind>';

test('DAV names and single reads are usable before a durable full-property preparation, with no synchronous whole-directory stat', async () => {
  const prepared = new Set<string>(); const stats: string[] = [];
  const source: SourcePlugin = {
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, value) => ({ ok: true, value }),
    roots: async () => ({ ok: true, value: { items: [{ sourceId: 'root', name: '来源', directoryRef: 'root' }] } }),
    list: async (ctx, _ref, cursor) => {
      const offset = Number(cursor ?? 0); const end = ctx.fileInfo === 'required' ? Math.min(offset + 2, 6) : 6;
      const items: Entry[] = [];
      for (let i = offset; i < end; i++) {
        const file = `${i}.wav`; if (ctx.fileInfo === 'required') prepared.add(file);
        items.push({ kind: 'file', entryId: file, name: file, fileRef: file, deferredInfo: true,
          ...(prepared.has(file) ? { info: info(file) } : {}) });
      }
      return { ok: true, value: { items, ...(end < 6 ? { nextCursor: String(end) } : {}) } };
    },
    stat: async (_ctx, file) => { stats.push(file); prepared.add(file); return { ok: true, value: info(file) }; },
    open: async (_ctx, file, request) => ({ ok: true, value: { content: info(file), servedRange: request.range ?? null,
      body: new Blob([request.range ? 'CD' : 'ABCDEFGH']).stream() } })
  };
  const f = await libraryFixture(source);
  try {
    await f.library.contentSources(f.id, signal()); await f.library.refresh(f.id, 'root', signal());
    const library = createLibrary(f.sources, f.store, undefined, { execution: 'deferred' });
    const app = createDav(library.files, { username: 'reader', password: 'password' });
    const request = (target: string, init: RequestInit) => app.request(target, { ...init, headers: { Authorization: authorization, ...init.headers } });
    const named = await request(url, { method: 'PROPFIND', headers: { Depth: '1' }, body: names });
    expect(named.status).toBe(207); expect(await named.text()).toContain('5.wav'); expect(stats).toEqual([]);
    const head = await request(url + '/0.wav', { method: 'HEAD' });
    expect(head.status).toBe(200); expect(head.headers.get('Content-Length')).toBe('8'); expect(stats).toEqual(['0.wav']);
    const read = await request(url + '/0.wav', { method: 'GET', headers: { Range: 'bytes=2-3', 'If-Range': head.headers.get('ETag')! } });
    expect(read.status).toBe(206); expect(await read.text()).toBe('CD'); expect(read.headers.get('ETag')).toBe(head.headers.get('ETag'));
    const before = stats.length;
    const full = await request(url, { method: 'PROPFIND', headers: { Depth: '1' } });
    expect(full.status).toBe(503); expect(full.headers.get('Retry-After')).toBe('2');
    expect(stats.length).toBe(before);
    const operationId = full.headers.get('X-MusicFS-Refresh')!;
    expect(await library.refreshes.get(operationId)).toMatchObject({ scope: { kind: 'file-info', directoryRef: 'root' }, status: 'queued' });
    const baseline = f.store.snapshot(f.id, { kind: 'directory', ref: 'root' })!.value!.id;
    let state = await library.refreshes.step(operationId, signal());
    expect(state.status).toBe('running'); expect(f.store.snapshot(f.id, { kind: 'directory', ref: 'root' })!.value!.id).toBe(baseline);
    expect(await library.files.list(path, signal())).toHaveLength(6);
    const again = await request(url, { method: 'PROPFIND', headers: { Depth: '1' } });
    expect(again.status).toBe(503); expect(again.headers.get('X-MusicFS-Refresh')).toBe(operationId);
    while (state.status === 'running') state = await library.refreshes.step(operationId, signal());
    const complete = await request(url, { method: 'PROPFIND', headers: { Depth: '1' } });
    expect(complete.status).toBe(207); const xml = await complete.text();
    expect(xml.match(/<D:getcontentlength>8<\/D:getcontentlength>/g)).toHaveLength(6);
    const after = await request(url + '/0.wav', { method: 'HEAD' });
    expect(after.headers.get('ETag')).toBe(head.headers.get('ETag')); expect(stats.length).toBe(before);
  } finally { f.close(); }
});
