import { expect, test } from 'bun:test';
import type { Context, Outcome } from '@musicfs/plugin-api';
import { createQqPlugin } from '../plugins/qq';
import type { QqHandler } from '../plugins/qq/client';
import { qqSession } from './helpers/qq-session';

const song = (mid: string) => ({ mid, title: '测试歌曲', singer: [{ name: '测试歌手' }], file: { media_mid: `media${mid}` } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const value = <T>(outcome: Outcome<T>): T => { if (!outcome.ok) throw new Error(outcome.error.message); return outcome.value; };
async function fixture() {
  let daily: unknown[] = [song('a'), song('b'), song('a')]; let likes: unknown[] = [song('a'), song('b'), song('a')];
  let unavailable = new Set(['b']); let badPlayback = false; let emptyMore = false; let emptyDaily = false;
  const mediaCalls: { url: string; range: string | null; signal: AbortSignal | null | undefined }[] = [];
  let etag = '"fixture-v1"'; let ignoreRange = false; let cancelled = 0;
  const handler: QqHandler = async request => {
    const url = new URL(request.url);
    if (url.pathname === '/login/status') return json({ data: { profile: { nickname: 'fixture' } } });
    if (url.pathname === '/user/daily-songs') return emptyDaily ? json({ errorKey: 'resource.not-found' }, 422) : json({ songs: daily });
    if (url.pathname === '/user/liked-songs') {
      const offset = Number(url.searchParams.get('offset'));
      return json({ songs: emptyMore ? [] : likes.slice(offset, offset + 2), total: likes.length, more: emptyMore || offset + 2 < likes.length });
    }
    return json({}, 404);
  };
  const request: typeof fetch = (async (input, init) => {
    if (init?.body) {
      const body = JSON.parse(String(init.body)); const response: Record<string, unknown> = { code: 0 };
      for (const [key, raw] of Object.entries(body)) if (key.startsWith('req_')) {
        const rpc = raw as { method: string; param: { filename: string[]; songmid: string[] } };
        if (rpc.method === 'GetCdnDispatch') { response[key] = { code: 0, data: { sip: ['https://stream.qqmusic.qq.com/'] } }; continue; }
        response[key] = { code: 0, data: badPlayback ? {} : { sip: ['https://stream.qqmusic.qq.com/'],
          midurlinfo: rpc.param.filename.map((filename, index) => ({ filename, songmid: rpc.param.songmid[index],
            purl: unavailable.has(rpc.param.songmid[index]!) ? '' : filename + '?private-vkey=fixture' })) } };
      }
      return json(response);
    }
    const headers = new Headers(init?.headers); const range = headers.get('range'); mediaCalls.push({ url: String(input), range, signal: init?.signal });
    const bytes = Uint8Array.from([10, 20, 30, 40, 50, 60]);
    const match = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    const start = match ? Number(match[1]) : 0; const end = match ? Number(match[2]) : bytes.length - 1;
    const partial = !!match && !ignoreRange;
    const slice = partial ? bytes.slice(start, end + 1) : bytes;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(slice); }, cancel() { cancelled++; } }), {
      status: partial ? 206 : 200, headers: { ETag: etag, 'Content-Length': String(slice.length), ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) }
    });
  }) as typeof fetch;
  const ctx: Context = { instanceId: 'fixture', config: { label: 'QQ', channel: 'qq' }, privateState: await qqSession(), signal: new AbortController().signal, fetch: request };
  return { plugin: createQqPlugin(handler), ctx, mediaCalls, get cancelled() { return cancelled; },
    setEtag(value: string) { etag = value; }, setIgnoreRange() { ignoreRange = true; }, setBadPlayback() { badPlayback = true; }, setEmptyMore() { emptyMore = true; },
    setEmptyDaily() { emptyDaily = true; }, setLikes(value: unknown[]) { likes = value; }, setDaily(value: unknown[]) { daily = value; }, allowAll() { unavailable = new Set(); } };
}

test('QQ preserves repeated song occurrences and complete liked pagination while hiding only confirmed unavailable files', async () => {
  const f = await fixture(); const roots = value(await f.plugin.roots(f.ctx)); expect(roots.items.map(root => root.sourceId)).toEqual(['liked', 'daily', 'created', 'favorites', 'recommended']);
  const first = value(await f.plugin.list(f.ctx, 'liked')); const second = value(await f.plugin.list(f.ctx, 'liked', first.nextCursor));
  expect(first.statistics).toMatchObject({ tracks: 2, files: 1 }); expect(second.statistics).toMatchObject({ tracks: 1, files: 1 }); expect(second.nextCursor).toBeUndefined();
  const files = [...first.items, ...second.items]; expect(new Set(files.map(item => item.entryId)).size).toBe(2);
  expect(files.map(item => item.name.slice(0, 4))).toEqual(['0001', '0003']);
  expect(files.map(item => item.kind === 'file' && item.fileRef)[0]).toBe(files.map(item => item.kind === 'file' && item.fileRef)[1]);
  expect(JSON.stringify(files)).not.toContain('private-vkey'); expect(JSON.stringify(files)).not.toContain('cdn.example');
});

test('QQ rejects truncated or changed paged collections, malformed songs and unknown playback responses', async () => {
  const f = await fixture(); const first = value(await f.plugin.list(f.ctx, 'liked')); f.setLikes([song('a')]);
  expect(await f.plugin.list(f.ctx, 'liked', first.nextCursor)).toMatchObject({ ok: false, error: { kind: 'content_changed' } });
  f.setEmptyMore(); expect(await f.plugin.list(f.ctx, 'liked')).toMatchObject({ ok: false, error: { kind: 'temporary' } });
  f.setDaily([{}]); expect(await f.plugin.list(f.ctx, 'daily')).toMatchObject({ ok: false, error: { kind: 'temporary' } });
  f.setDaily([song('a')]); f.setBadPlayback(); expect(await f.plugin.list(f.ctx, 'daily')).toMatchObject({ ok: false, error: { kind: 'temporary' } });
});

test('QQ daily recommendation is finite and an explicitly empty feed is a successful empty directory', async () => {
  const f = await fixture(); const daily = value(await f.plugin.list(f.ctx, 'daily'));
  expect(daily.items).toHaveLength(2); expect(daily.statistics).toMatchObject({ tracks: 3, files: 2 }); expect(daily.nextCursor).toBeUndefined();
  f.setEmptyDaily(); expect(value(await f.plugin.list(f.ctx, 'daily'))).toEqual({ items: [], statistics: { tracks: 0, files: 0 } });
});

test('QQ stat probes one byte; audio open preserves upstream range and cancellation without exposing media URLs', async () => {
  const f = await fixture(); f.setDaily([song('a')]); const file = value(await f.plugin.list(f.ctx, 'daily')).items[0]!;
  if (file.kind !== 'file') throw new Error('Expected audio');
  const info = value(await f.plugin.stat(f.ctx, file.fileRef)); expect(info.size).toBe(6); expect(info.mediaType).toBe('audio/mpeg');
  expect(f.mediaCalls[0]?.range).toBe('bytes=0-0'); expect(f.cancelled).toBe(2);
  const opened = value(await f.plugin.open(f.ctx, file.fileRef, { expectedContentId: info.contentId, range: { start: 3, end: 5 } }));
  expect(opened.servedRange).toEqual({ start: 3, end: 5 }); expect(opened.content).toEqual(info);
  const reader = opened.body.getReader(); expect((await reader.read()).value).toEqual(Uint8Array.from([40, 50, 60])); await reader.cancel();
  expect(f.cancelled).toBe(4); expect(f.mediaCalls[3]?.signal).toBe(f.ctx.signal); expect(info.contentId).not.toContain('private-vkey');
});

test('QQ refuses ignored ranges and changed representations, cancelling their response bodies', async () => {
  const f = await fixture(); const file = value(await f.plugin.list(f.ctx, 'daily')).items[0]!; if (file.kind !== 'file') throw new Error('Expected file');
  const info = value(await f.plugin.stat(f.ctx, file.fileRef)); f.setEtag('"changed"');
  expect(await f.plugin.open(f.ctx, file.fileRef, { expectedContentId: info.contentId })).toMatchObject({ ok: false, error: { kind: 'content_changed' } });
  f.setIgnoreRange(); expect(await f.plugin.open(f.ctx, file.fileRef, { expectedContentId: info.contentId, range: { start: 1, end: 2 } })).toMatchObject({ ok: false, error: { kind: 'not_supported' } });
  expect(f.cancelled).toBeGreaterThanOrEqual(5);
});
