import { mediaBytes, memoryCache, metadataFetch, qqTrackFields } from './helpers/source-metadata';
import { expect, test } from 'bun:test';
import type { Context, Entry, Json, Outcome } from '@musicfs/plugin-api';
import { createQqPlugin } from '../plugins/qq';
import { createSealedSessionResolver, deriveAndroidDevice } from '../plugins/qq/generated-upstream.mjs';
import type { QqHandler } from '../plugins/qq/client';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const value = <T>(outcome: Outcome<T>): T => { if (!outcome.ok) throw new Error(outcome.error.message); return outcome.value; };
const directory = (item: Entry | undefined) => { if (item?.kind !== 'directory') throw new Error('Expected directory'); return item.directoryRef; };
const song = (mid: string) => ({ ...qqTrackFields, mid, title: '歌曲', singer: [{ name: '歌手' }], file: { media_mid: 'media' + mid } });
async function fixture(account = '123') {
  const secret = 'native-sdk-fixture-secret-32-characters-' + account;
  const credential = { musicid: account, str_musicid: account, musickey: 'private-native-key-' + account, loginType: 2, encryptUin: 'encrypted-' + account };
  const token = await createSealedSessionResolver({ secrets: { current: secret } }).issue({ credential,
    device: await deriveAndroidDevice(secret), expiresAt: Date.now() + 60 * 60 * 1000 });
  const state: Json = { version: 2, secret, token, accountName: null, pending: null, renewAfter: 0 };
  let created: Record<string, unknown> = { v_playlist: [{ tid: 7, dirId: 1, dirName: '收藏歌单' }, { tid: 0, dirId: 201, dirName: '' }], total: 2, bFinish: true };
  let favorites: unknown[] = [{ id: 7, title: '我的歌单' }, { id: 8, title: '另一份' }, { id: 10, title: '末页' }];
  let favoriteMoreEmpty = false; let code = 0; let block = false;
  let totalSongs = 3; let songs = [song('a'), song('b'), song('a')]; let corruptSongs = false;
  const nativeCalls: { method: string; param: Record<string, unknown>; cookie: string | null }[] = [];
  let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
  let cancelled = false; let recommendedCalls = 0;
  const fetcher = (async (_input, init) => {
    if (!init?.body) { const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')!; const start = Number(range[1]); const end = Number(range[2]); return new Response(mediaBytes.mp3.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${mediaBytes.mp3.length}`, 'Content-Length': String(end - start + 1), ETag: '"fixture-file"' } }); }
    const rpc = JSON.parse(String(init?.body)); const request = rpc.req_0; nativeCalls.push({ method: request.method, param: request.param, cookie: new Headers(init?.headers).get('cookie') });
    started();
    if (block) return new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => { cancelled = true; reject(init!.signal!.reason); }, { once: true }); });
    let data: unknown;
    if (request.method === 'UrlGetVkey') {
      const filenames = request.param.filename as string[];
      return json({ code: 0, req_0: { code, data: { sip: [], midurlinfo: filenames.map((filename, index) => ({ filename, songmid: request.param.songmid[index], purl: filename + '?vkey=private' })) } } });
    }
    if (request.method === 'GetRecommendFeed') { recommendedCalls++; data = { List: [{ Playlist: { basic: { tid: 100, title: '推荐歌单' } } }], HasMore: true }; }
    else if (request.method === 'GetPlaylistByUin') data = created;
    else if (request.method === 'CgiGetPlaylistFavInfo') {
      const offset = Number(request.param.offset); const items = favoriteMoreEmpty ? [] : favorites.slice(offset, offset + 2);
      data = { v_list: items, total: favorites.length, hasmore: favoriteMoreEmpty || offset + items.length < favorites.length ? 1 : 0 };
    } else {
      const offset = Number(request.param.song_begin); data = { songlist: corruptSongs ? [{}] : songs.slice(offset, offset + 2), total_song_num: totalSongs, hasmore: 1 };
    }
    return json({ code: 0, req_0: { code, data } });
  }) as typeof fetch;
  const handler: QqHandler = async request => {
    const url = new URL(request.url);
    if (url.pathname === '/login/status') return json({ data: { profile: { nickname: 'fixture' } } });
    if (url.pathname === '/recommend/playlists') { recommendedCalls++; return json({ playlists: [{ tid: 100, title: '推荐歌单' }], more: true }); }
    if (url.pathname === '/getMusicPlay') { const mid = url.searchParams.get('songmid')!; return json({ data: { playUrl: { [mid]: { url: `https://cdn.example.test/M500${mid}media${mid}.mp3?vkey=private` } } } }); }
    return json({}, 404);
  };
  const controller = new AbortController();
  const ctx: Context = { instanceId: 'fixture-' + account, config: {}, privateState: state, fetch: metadataFetch(fetcher), cache: memoryCache(), signal: controller.signal };
  return { plugin: createQqPlugin(handler), ctx, nativeCalls, controller, start, get cancelled() { return cancelled; }, get recommendedCalls() { return recommendedCalls; },
    setCreated(next: Record<string, unknown>) { created = next; }, setFavorites(next: unknown[]) { favorites = next; }, setEmptyMore() { favoriteMoreEmpty = true; },
    setCode(next: number) { code = next; }, setBlock() { block = true; }, setSongs(next: ReturnType<typeof song>[], total = next.length) { songs = next; totalSongs = total; }, corruptSongs() { corruptSongs = true; } };
}

test('QQ native collections preserve independent roles and exclude liked by system ID rather than its name', async () => {
  const f = await fixture(); const created = value(await f.plugin.list(f.ctx, 'created')); const favorite = value(await f.plugin.list(f.ctx, 'favorites'));
  expect(created.items.map(item => item.name)).toEqual(['收藏歌单']); expect(created.items[0]?.entryId).toBe('7'); expect(favorite.items[0]?.entryId).toBe('7');
  expect(JSON.parse(directory(created.items[0]))).toMatchObject({ role: 'created', tid: '7', dirId: 1 });
  expect(JSON.parse(directory(favorite.items[0]))).toMatchObject({ role: 'favorites', tid: '7' });
  expect(f.nativeCalls[0]?.param).toEqual({ uin: '123' }); expect(f.nativeCalls[1]?.param).toEqual({ uin: 'encrypted-123', offset: 0, size: 100 });
  expect(JSON.stringify([created, favorite])).not.toContain('private-native-key'); expect(JSON.stringify([created, favorite])).not.toContain('encrypted-123');
});

test('QQ favorites retain every page and cursor ownership; created totals and truncated favorites cannot pass as complete', async () => {
  const f = await fixture(); const first = value(await f.plugin.list(f.ctx, 'favorites')); const last = value(await f.plugin.list(f.ctx, 'favorites', first.nextCursor));
  expect([...first.items, ...last.items].map(item => item.entryId)).toEqual(['7', '8', '10']); expect(last.nextCursor).toBeUndefined();
  expect(f.nativeCalls.at(-1)?.param.offset).toBe(2);
  expect(await f.plugin.list(f.ctx, 'created', first.nextCursor)).toMatchObject({ ok: false, error: { kind: 'not_found' } });
  f.setEmptyMore(); expect(await f.plugin.list(f.ctx, 'favorites')).toMatchObject({ ok: false, error: { kind: 'temporary' } });
  f.setCreated({ v_playlist: [], total: 4, bFinish: false }); expect(await f.plugin.list(f.ctx, 'created')).toMatchObject({ ok: false, error: { kind: 'not_supported' } });
});

test('QQ uses the authenticated owner endpoint for private own playlists and the authenticated general endpoint for favorites', async () => {
  const f = await fixture(); const own = directory(value(await f.plugin.list(f.ctx, 'created')).items[0]);
  const favorite = directory(value(await f.plugin.list(f.ctx, 'favorites')).items[0]);
  const first = value(await f.plugin.list(f.ctx, own)); const last = value(await f.plugin.list(f.ctx, own, first.nextCursor));
  expect([...first.items, ...last.items].map(item => item.name.slice(0, 4))).toEqual(['0001', '0002', '0003']); expect(last.nextCursor).toBeUndefined();
  const ownCall = f.nativeCalls.find(call => call.method === 'CgiGetDiss'); expect(ownCall?.param).toMatchObject({ disstid: 7, dirid: 1, enc_host_uin: 'encrypted-123', song_begin: 0 });
  expect(ownCall?.param.song_num).toBeGreaterThanOrEqual(3); expect(ownCall?.param.song_num).toBeLessThanOrEqual(100);
  await f.plugin.list(f.ctx, favorite); expect(f.nativeCalls.findLast(call => call.method === 'uniform_get_Dissinfo')).toMatchObject({ method: 'uniform_get_Dissinfo', param: { disstid: 7, enc_host_uin: '', song_begin: 0 } });
  expect(JSON.stringify(first)).not.toContain('vkey=');
});

test('QQ recommended playlists form a finite snapshot even if the feed advertises more, and their contents are paged', async () => {
  const f = await fixture(); const feed = value(await f.plugin.list(f.ctx, 'recommended')); expect(feed.items).toHaveLength(1); expect(feed.nextCursor).toBeUndefined(); expect(f.recommendedCalls).toBe(1);
  const reference = directory(feed.items[0]); const first = value(await f.plugin.list(f.ctx, reference)); const last = value(await f.plugin.list(f.ctx, reference, first.nextCursor));
  expect(first.statistics).toMatchObject({ tracks: 2, files: 2 }); expect(last.statistics).toMatchObject({ tracks: 1, files: 1 }); expect(last.nextCursor).toBeUndefined();
  expect(await f.plugin.list(f.ctx, 'recommended', first.nextCursor)).toMatchObject({ ok: false, error: { kind: 'not_found' } });
  f.corruptSongs(); expect(await f.plugin.list(f.ctx, reference)).toMatchObject({ ok: false, error: { kind: 'temporary' } });
});

test('QQ native transport isolates account cookies and credential rejection clears only its instance candidate', async () => {
  const a = await fixture('123'); const b = await fixture('456'); await a.plugin.list(a.ctx, 'favorites'); await b.plugin.list(b.ctx, 'favorites');
  expect(a.nativeCalls[0]?.cookie).toContain('private-native-key-123'); expect(a.nativeCalls[0]?.cookie).not.toContain('private-native-key-456');
  expect(b.nativeCalls[0]?.param.uin).toBe('encrypted-456');
  a.setCode(104400); const rejected = await a.plugin.list(a.ctx, 'favorites'); expect(rejected).toMatchObject({ ok: false, error: { kind: 'needs_auth' }, nextPrivateState: { token: null } });
  expect(await b.plugin.list(b.ctx, 'favorites')).toMatchObject({ ok: true });
});

test('QQ native SDK fetch receives cancellation from the host without changing a global transport', async () => {
  const f = await fixture(); f.setBlock(); const work = f.plugin.list(f.ctx, 'favorites'); await f.start;
  f.controller.abort(new Error('fixture-cancelled')); await expect(work).rejects.toThrow('fixture-cancelled'); expect(f.cancelled).toBe(true);
});
