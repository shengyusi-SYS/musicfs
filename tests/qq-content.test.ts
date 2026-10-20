import { mediaBytes, memoryCache, metadataFetch, qqTrackFields } from './helpers/source-metadata';
import { expect, test } from 'bun:test';
import type { Context, Outcome } from '@musicfs/plugin-api';
import { createQqPlugin } from '../plugins/qq';
import type { QqHandler } from '../plugins/qq/client';
import { qqSession } from './helpers/qq-session';
import { parseId3 } from '../packages/audio-tags/test-fixtures';
import { Id3v2FrameClassType, Id3v2FrameIdentifiers, type Id3v2UnsynchronizedLyricsFrame } from '../packages/audio-tags/test-fixtures';

const song = (mid: string) => ({ ...qqTrackFields, mid, title: '测试歌曲', singer: [{ name: '测试歌手' }], file: { media_mid: `media${mid}` } });
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
        const rpc = raw as { method: string; param: { filename: string[]; songmid: string[]; song_begin: number } };
        if (rpc.method === 'uniform_get_Dissinfo') { response[key] = { code: 0, data: { songlist: emptyDaily ? [] : daily } }; continue; }
        if (rpc.method === 'CgiGetDiss') { const offset = rpc.param.song_begin; response[key] = { code: 0, data: { songlist: emptyMore ? [] : likes.slice(offset, offset + 2), total_song_num: likes.length, hasmore: 1 } }; continue; }
        if (rpc.method === 'GetCdnDispatch') { response[key] = { code: 0, data: { sip: ['https://stream.qqmusic.qq.com/'] } }; continue; }
        response[key] = { code: 0, data: badPlayback ? {} : { sip: ['https://stream.qqmusic.qq.com/'],
          midurlinfo: rpc.param.filename.map((filename, index) => ({ filename, songmid: rpc.param.songmid[index],
            purl: unavailable.has(rpc.param.songmid[index]!) ? '' : filename + '?private-vkey=fixture' })) } };
      }
      return json(response);
    }
    const headers = new Headers(init?.headers); const range = headers.get('range'); mediaCalls.push({ url: String(input), range, signal: init?.signal });
    const bytes = mediaBytes.mp3;
    const match = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    const start = match ? Number(match[1]) : 0; const end = match ? Number(match[2]) : bytes.length - 1;
    const partial = !!match && !ignoreRange;
    const slice = partial ? bytes.slice(start, end + 1) : bytes;
    let sent = false; return new Response(new ReadableStream({ pull(controller) { if (sent) { if (!(start === 0 && end === 0)) controller.close(); } else { sent = true; controller.enqueue(slice); } }, cancel() { cancelled++; } }), {
      status: partial ? 206 : 200, headers: { ETag: etag, 'Content-Length': String(slice.length), ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) }
    });
  }) as typeof fetch;
  const ctx: Context = { instanceId: 'fixture', config: { label: 'QQ', channel: 'qq' }, privateState: await qqSession(), signal: new AbortController().signal, fetch: metadataFetch(request), cache: memoryCache() };
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
  expect(files.every(file => file.kind === 'file' && (file.info?.size ?? 0) > mediaBytes.mp3.length)).toBe(true);
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
  f.setEmptyDaily(); expect(value(await f.plugin.list(f.ctx, 'daily'))).toMatchObject({ items: [], statistics: { tracks: 0, files: 0 } });
});

test('QQ legacy file references retain raw stat, byte ranges and cancellation after tagged listing', async () => {
  const f = await fixture(); f.setDaily([song('a')]); const file = value(await f.plugin.list(f.ctx, 'daily')).items[0]!;
  if (file.kind !== 'file') throw new Error('Expected audio');
  const legacyRef = JSON.stringify(JSON.parse(file.fileRef).source);
  const before = f.mediaCalls.length; const cancelled = f.cancelled;
  const info = value(await f.plugin.stat(f.ctx, legacyRef)); expect(info.size).toBe(mediaBytes.mp3.length); expect(info.mediaType).toBe('audio/mpeg');
  expect(f.mediaCalls[before]?.range).toBe('bytes=0-0'); expect(f.cancelled).toBeGreaterThan(cancelled);
  const opened = value(await f.plugin.open(f.ctx, legacyRef, { expectedContentId: info.contentId, range: { start: 3, end: 5 } }));
  expect(opened.servedRange).toEqual({ start: 3, end: 5 }); expect(opened.content).toEqual(info);
  const reader = opened.body.getReader(); expect((await reader.read()).value).toEqual(mediaBytes.mp3.slice(3, 6)); await reader.cancel();
  expect(f.mediaCalls.at(-1)?.signal).toBe(f.ctx.signal); expect(info.contentId).not.toContain('private-vkey');
});

test('QQ refuses ignored ranges and changed representations, cancelling their response bodies', async () => {
  const f = await fixture(); const file = value(await f.plugin.list(f.ctx, 'daily')).items[0]!; if (file.kind !== 'file') throw new Error('Expected file');
  const info = value(await f.plugin.stat(f.ctx, file.fileRef)); f.setEtag('"changed"');
  expect(await f.plugin.open(f.ctx, file.fileRef, { expectedContentId: info.contentId })).toMatchObject({ ok: false, error: { kind: 'content_changed' } });
  f.setIgnoreRange(); expect(await f.plugin.open(f.ctx, file.fileRef, { expectedContentId: info.contentId, range: { start: info.size - 10, end: info.size - 5 } })).toMatchObject({ ok: false, error: { kind: 'not_supported' } });
  expect(f.cancelled).toBeGreaterThanOrEqual(2);
});

test('QQ prepares complete music tags once across repeated occurrences, then serves stable final bytes without music-data reads', async () => {
  const f = await fixture();
  f.setDaily([{ ...qqTrackFields, mid: 'a', title: '来源歌名', singer: [{ name: '第一歌手' }, { name: '第二歌手' }], file: { media_mid: 'mediaa' } },
    { ...qqTrackFields, mid: 'a', title: '来源歌名', singer: [{ name: '第一歌手' }, { name: '第二歌手' }], file: { media_mid: 'mediaa' } }]);
  const native = f.ctx.fetch; const counts = { album: 0, lyrics: 0, cover: 0 };
  f.ctx.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.includes('fcg_v8_album_info')) counts.album++;
    if (url.pathname.includes('/lyric/')) { expect(url.searchParams.get('nobase64')).toBe('1'); counts.lyrics++; return Response.json({ code: 0, lyric: 'Plain original lyrics', trans: 'Plain translation' }); }
    if (init?.body) {
      const body = JSON.parse(String(init.body)) as Record<string, { method?: string; param?: Record<string, unknown> }>;
      const lyric = Object.entries(body).find(([, value]) => value?.method === 'GetPlayLyricInfo');
      if (lyric) {
        expect(lyric[1].param).toMatchObject({ songMID: 'a', trans: 1, roma: 1 }); counts.lyrics++;
        return Response.json({ code: 0, [lyric[0]]: { code: 0, data: { roma: btoa('[00:00.00]Romanization') } } });
      }
    }
    if (url.hostname === 'y.gtimg.cn') counts.cover++;
    return native(input, init);
  }) as typeof fetch;
  const listed = value(await f.plugin.list(f.ctx, 'daily')); expect(listed.items).toHaveLength(2);
  const entry = listed.items[0]!; if (entry.kind !== 'file') throw new Error('Expected file');
  expect(listed.items[1]?.kind === 'file' && listed.items[1].fileRef).toBe(entry.fileRef);
  expect(counts).toEqual({ album: 1, lyrics: 2, cover: 1 });
  const info = value(await f.plugin.stat(f.ctx, entry.fileRef)); expect(info).toEqual(entry.info!);
  const full = value(await f.plugin.open(f.ctx, entry.fileRef, { expectedContentId: info.contentId }));
  const bytes = new Uint8Array(await new Response(full.body).arrayBuffer()); expect(bytes.length).toBe(info.size);
  const tag = parseId3(bytes);
  expect(tag.title).toBe('来源歌名'); expect(tag.performers).toEqual(['第一歌手', '第二歌手']); expect(tag.album).toBe('专辑');
  expect(tag.albumArtists).toEqual(['专辑歌手']); expect(tag.getTextAsString(Id3v2FrameIdentifiers.TYER!)).toBe('2020'); expect(tag.getTextAsString(Id3v2FrameIdentifiers.TDAT!)).toBe('0302');
  expect(tag.track).toBe(7); expect(tag.disc).toBe(2); expect(tag.pictures).toHaveLength(1);
  const lyrics = tag.getFramesByClassType<Id3v2UnsynchronizedLyricsFrame>(Id3v2FrameClassType.UnsynchronizedLyricsFrame);
  expect(lyrics.map(frame => [frame.description, frame.text])).toEqual([['', 'Plain original lyrics'], ['translation', 'Plain translation'], ['romanization', '[00:00.00]Romanization']]);
  const range = { start: info.size - 64, end: info.size - 1 };
  const partial = value(await f.plugin.open(f.ctx, entry.fileRef, { expectedContentId: info.contentId, range }));
  expect(new Uint8Array(await new Response(partial.body).arrayBuffer())).toEqual(bytes.slice(range.start));
  expect(counts).toEqual({ album: 1, lyrics: 2, cover: 1 });
  const cancellable = value(await f.plugin.open(f.ctx, entry.fileRef, { expectedContentId: info.contentId }));
  const upstreamSignal = f.mediaCalls.at(-1)!.signal!;
  expect(upstreamSignal.aborted).toBe(false); await cancellable.body.cancel();
  expect(upstreamSignal.aborted).toBe(true); expect(f.ctx.signal.aborted).toBe(false);
  const cache = f.ctx.cache as ReturnType<typeof memoryCache>; cache.values.delete(JSON.parse(entry.fileRef).planKey);
  expect(await f.plugin.stat(f.ctx, entry.fileRef)).toMatchObject({ ok: false, error: { kind: 'temporary' } });
  // A deliberate refresh can reconstruct a lost plan; a file read never falls back to raw bytes.
  const restored = value(await f.plugin.list(f.ctx, 'daily')).items[0]!;
  expect(restored.kind === 'file' && restored.info).toEqual(info);
});

test('QQ new listings require the optional host cache while legacy raw references remain readable', async () => {
  const f = await fixture(); f.setDaily([song('a')]); delete f.ctx.cache;
  expect(await f.plugin.list(f.ctx, 'daily')).toMatchObject({ ok: false, error: { kind: 'not_supported' } });
  const ref = JSON.stringify({ version: 1, mid: 'a', mediaId: 'mediaa', quality: '128', filename: 'M500amediaa.mp3' });
  expect(value(await f.plugin.stat(f.ctx, ref)).size).toBe(mediaBytes.mp3.length);
});
