import { mediaBytes, mediaFor, memoryCache, metadataFetch } from './helpers/source-metadata';
import { expect, test } from 'bun:test';
import type { AuthStep, Context, Json, Outcome } from '@musicfs/plugin-api';
import plugin from '../plugins/netease';
import { encrypt } from '../plugins/netease/generated-upstream.mjs';
import { NeteaseClient } from '../plugins/netease/client';
import { resolveMedia } from '../plugins/netease/media';
import { parseId3 } from '../packages/audio-tags/test-fixtures';
import { Id3v2FrameClassType, Id3v2FrameIdentifiers, type Id3v2UnsynchronizedLyricsFrame } from '../packages/audio-tags/test-fixtures';

const bytes = mediaBytes.mp3;
function value<T>(outcome: Outcome<T>): T { if (!outcome.ok) throw new Error(outcome.error.message); return outcome.value; }
function waiting(step: AuthStep) { if (step.kind !== 'waiting') throw new Error('Expected QR step'); return step; }
function fixture() {
  const calls: { path: string; cookie: string; signal: AbortSignal | null }[] = [];
  let statusUnavailable = false; let brokenVersion = false; let preview = true; let cancelledBody = false;
  let statusBody: unknown = { code: 200, profile: { userId: 42, nickname: '测试账号' } };
  let playlistIds = [1, 2, 1]; let wrongTrackCount = false; let missingPlayback = false;
  let likedPlaylistId = 8; const playlistCalls: string[] = [];
  let playbackRows = (rows: Record<string, unknown>[], _level: string) => rows;
  const playbackCalls: { ids: number[]; level: string }[] = [];
  const fakeFetch: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init); const url = new URL(req.url);
    calls.push({ path: url.pathname, cookie: req.headers.get('cookie') ?? '', signal: req.signal });
    const json = (body: unknown, cookies: string[] = [], status = 200) => {
      const headers = new Headers({ 'Content-Type': 'application/json' }); for (const cookie of cookies) headers.append('Set-Cookie', cookie);
      return Response.json(body, { status, headers });
    };
    if (url.hostname === 'm1.music.126.net') {
      const bytes = mediaFor(url.href);
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get('range') ?? '');
      const selected = range ? bytes.slice(Number(range[1]), Number(range[2]) + 1) : bytes;
      let sent = false;
      return new Response(new ReadableStream({ pull(controller) { if (sent) controller.close(); else { sent = true; controller.enqueue(selected); } }, cancel() { cancelledBody = true; } }), { status: range ? 206 : 200,
        headers: { 'Content-Length': String(selected.length), ...(range ? { 'Content-Range': `bytes ${range[1]}-${range[2]}/${bytes.length}` } : {}) } });
    }
    const path = url.pathname.replace(/^\/(eapi|weapi)\//, '/api/');
    if (path === '/api/login/qrcode/unikey') return json({ code: 200, unikey: 'upstream-qr-key' });
    if (path === '/api/login/qrcode/client/login') return json({ code: 803 }, [
      'MUSIC_U=private-session; Domain=.music.163.com; Path=/; HttpOnly; Secure; Expires=Thu, 31 Dec 2099 23:59:59 GMT',
      '__csrf=private-csrf; Domain=.music.163.com; Path=/; Secure'
    ]);
    if (path === '/api/w/nuser/account/get') return statusUnavailable ? json({}, [], 502) : json(statusBody);
    if (path === '/api/user/playlist') return json({ code: 200, more: false, playlist: [
      { id: likedPlaylistId, userId: 42, specialType: 5, name: '不能按名字猜的系统集合' },
      { id: 9, userId: 42, specialType: 0, name: '自建歌单' }, { id: 10, userId: 52, specialType: 0, name: '收藏歌单' }
    ] });
    if (path === '/api/v6/playlist/detail') {
      const parameters = new URLSearchParams(await req.text()); const decrypted = encrypt.eapiReqDecrypt(parameters.get('params')!);
      playlistCalls.push(String(decrypted!.data.id));
      return json({ code: 200, playlist: { trackCount: playlistIds.length + (wrongTrackCount ? 1 : 0), trackIds: playlistIds.map(id => ({ id })) } });
    }
    if (path === '/api/song/detail/') return json({ code: 200, songs: [...new Set(playlistIds)].reverse().map(id => ({ id, name: `歌曲${id}`, artists: [{ name: '歌手' }] })) });
    if (path === '/api/song/enhance/player/url/v1') {
      const parameters = new URLSearchParams(await req.text()); const decrypted = encrypt.eapiReqDecrypt(parameters.get('params')!);
      const ids = JSON.parse(String(decrypted!.data.ids)) as number[];
      const selected = String(decrypted!.data.level); playbackCalls.push({ ids, level: selected });
      return json({ code: 200, data: playbackRows((missingPlayback ? [] : ids).map(id => ({ id, url: `https://m1.music.126.net/temporary-${calls.length}/${id}.mp3`, expi: 1200, level: 'standard', type: 'mp3', size: bytes.length,
        md5: brokenVersion ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : '00000000000000000000000000000000', freeTrialInfo: preview && id === 2 ? { start: 0, end: 30 } : null })), selected) });
    }
    if (path === '/api/v3/discovery/recommend/songs') return json({ code: 200, data: { dailySongs: [{ id: 1, name: '完整音频', ar: [{ name: '歌手' }] }] } });
    return json({ code: 404 }, [], 404);
  }, { preconnect: fetch.preconnect });
  const ctx: Context = { instanceId: 'netease-a', config: { label: '网易云', quality: 'standard' }, privateState: null, signal: new AbortController().signal, fetch: metadataFetch(fakeFetch), cache: memoryCache() };
  return { ctx, calls, playbackCalls, playlistCalls, setLikedPlaylistId(id: number) { likedPlaylistId = id; }, setStatusUnavailable(state: boolean) { statusUnavailable = state; }, setStatusBody(body: unknown) { statusBody = body; }, setBrokenVersion(state: boolean) { brokenVersion = state; },
    setPreview(state: boolean) { preview = state; }, setPlaylistIds(ids: number[]) { playlistIds = ids; }, setWrongTrackCount(state: boolean) { wrongTrackCount = state; },
    setPlaybackRows(transform: typeof playbackRows) { playbackRows = transform; },
    setMissingPlayback(state: boolean) { missingPlayback = state; }, cancelledBody: () => cancelledBody };
}
async function authorize(f: ReturnType<typeof fixture>, resolveIdentity = true) {
  const started = await plugin.authenticate!(f.ctx, { kind: 'start' }); f.ctx.privateState = started.nextPrivateState!;
  const qr = waiting(value(started)); const completed = await plugin.authenticate!(f.ctx, { kind: 'poll', challengeId: qr.challengeId });
  expect(value(completed).kind).toBe('complete'); f.ctx.privateState = completed.nextPrivateState!;
  if (resolveIdentity) { const roots = await plugin.roots(f.ctx); value(roots); f.ctx.privateState = roots.nextPrivateState ?? f.ctx.privateState; }
}
const audio = (qualities: string[], missingQuality = 'hide', mode = qualities.length > 1 ? 'multiple' : 'single'): Json => ({ quality: qualities[0] ?? 'standard', audio: { mode, qualities, missingQuality } });
async function qualityFixture() {
  const f = fixture(); await authorize(f); f.setPreview(false);
  const available = new Map<string, { level: string; type?: string; preview?: boolean }>();
  f.setPlaybackRows((rows, requested) => rows.map(row => {
    const selected = available.get(`${row.id}:${requested}`);
    if (!selected) return { ...row, level: requested, url: null };
    const type = selected.type ?? (selected.level === 'hires' || selected.level === 'lossless' ? 'FLAC' : 'MP3');
    const digest = selected.level === 'hires' ? 'a' : selected.level === 'lossless' ? 'b' : selected.level === 'exhigh' ? 'c' : 'd';
    return { ...row, level: selected.level, type, size: mediaFor(`https://m1.music.126.net/fixture.${type.toLowerCase()}`).length, md5: digest.repeat(32), freeTrialInfo: selected.preview ? { start: 0, end: 30 } : null,
      url: `https://m1.music.126.net/temporary/${row.id}-${selected.level}.${type.toLowerCase()}` };
  }));
  return { ...f, available };
}

test('NetEase configuration has no credentials and creates independent Cookie jars', async () => {
  const first = fixture(); const second = fixture();
  const a = await plugin.validateConfig(first.ctx, {}); const b = await plugin.validateConfig(second.ctx, {});
  expect(value(a)).toEqual({ label: '网易云音乐', quality: 'standard', audio: { mode: 'single', qualities: ['standard'], missingQuality: 'hide' } }); expect(a.nextPrivateState).not.toEqual(b.nextPrivateState);
  expect(await plugin.validateConfig(first.ctx, { cookie: 'secret' })).toMatchObject({ ok: false, error: { kind: 'invalid_config' } });
});

test('NetEase real SDK callbacks exchange QR and restore correctly scoped, expiring cookies', async () => {
  const f = fixture(); await authorize(f);
  const saved = JSON.stringify(f.ctx.privateState); expect(saved).toContain('private-session'); expect(saved).toContain('2099-12-31');
  expect(value(await plugin.roots(f.ctx)).items).toHaveLength(5);
  expect(f.calls.at(-1)!.cookie).toContain('MUSIC_U=private-session'); expect(f.calls.at(-1)!.cookie).toContain('__csrf=private-csrf');
  const other = fixture(); expect(await plugin.roots(other.ctx)).toMatchObject({ ok: false, error: { kind: 'needs_auth' } }); expect(other.calls).toHaveLength(0);
  const started = await plugin.authenticate!(other.ctx, { kind: 'start' }); const step = waiting(value(started));
  expect(step.challengeId).not.toBe('upstream-qr-key'); expect(JSON.stringify(step)).not.toContain('private-session');
});

test('NetEase QR authorization completes before optional profile lookup and content can retry without scanning again', async () => {
  const f = fixture(); f.setStatusUnavailable(true); await authorize(f, false);
  expect(f.ctx.privateState).toMatchObject({ accountId: null, accountName: null, pending: null });
  expect(f.calls.some(call => call.path.includes('/nuser/account/get'))).toBe(false);
  expect(await plugin.roots(f.ctx)).toMatchObject({ ok: false, error: { kind: 'temporary' } });
  expect(JSON.stringify(f.ctx.privateState)).toContain('private-session');
  const profileCalls = f.calls.filter(call => call.path.includes('/nuser/account/get')).length;
  const daily = value(await plugin.list(f.ctx, 'daily')); const file = daily.items[0]!; if (file.kind !== 'file') throw new Error('Expected file');
  const info = value(await plugin.stat(f.ctx, file.fileRef));
  const opened = value(await plugin.open(f.ctx, file.fileRef, { expectedContentId: info.contentId })); await opened.body.cancel();
  expect(f.calls.filter(call => call.path.includes('/nuser/account/get'))).toHaveLength(profileCalls);
  f.setStatusUnavailable(false); const roots = await plugin.roots(f.ctx);
  expect(value(roots).items).toHaveLength(5); expect(roots.nextPrivateState).toMatchObject({ accountId: '42', accountName: '测试账号' });
  expect(f.calls.filter(call => call.path.includes('qrcode/client/login'))).toHaveLength(1);
});

test('NetEase a new QR session clears the previous identity and resolves the current owner when personal playlists need it', async () => {
  const f = fixture(); await authorize(f); expect(f.ctx.privateState).toMatchObject({ accountId: '42' });
  f.setStatusBody({ code: 200, profile: { userId: 52, nickname: '切换后的账号' } }); await authorize(f, false);
  expect(f.ctx.privateState).toMatchObject({ accountId: null, accountName: null, pending: null });
  const created = await plugin.list(f.ctx, 'created'); expect(value(created).items.map(item => item.entryId)).toEqual(['10']);
  expect(created.nextPrivateState).toMatchObject({ accountId: '52', accountName: '切换后的账号' });
  f.ctx.privateState = created.nextPrivateState!;
  expect(value(await plugin.list(f.ctx, 'favorites')).items.map(item => item.entryId)).toEqual(['9']);
});

test('NetEase missing or expired session cookies require reauthorization before making a protected request', async () => {
  for (const expired of [false, true]) {
    const f = fixture(); await authorize(f);
    const state = structuredClone(f.ctx.privateState) as { cookies: string; accountId: string | null; accountName: string | null };
    const jar = JSON.parse(state.cookies) as { cookies: { key: string; expires?: string }[] };
    if (expired) jar.cookies.find(cookie => cookie.key === 'MUSIC_U')!.expires = '2000-01-01T00:00:00.000Z';
    else jar.cookies = jar.cookies.filter(cookie => cookie.key !== 'MUSIC_U');
    state.cookies = JSON.stringify(jar); f.ctx.privateState = state;
    const before = f.calls.length; const failure = await plugin.list(f.ctx, 'created');
    expect(failure).toMatchObject({ ok: false, error: { kind: 'needs_auth' }, nextPrivateState: { accountId: null, accountName: null } });
    expect(f.calls).toHaveLength(before); expect(JSON.stringify(failure.nextPrivateState)).not.toContain('private-session');
    f.ctx.privateState = failure.nextPrivateState!; await authorize(f);
    expect(value(await plugin.roots(f.ctx)).items).toHaveLength(5);
    expect(f.calls.some(call => call.path.includes('/login/token/refresh'))).toBe(false);
  }
});

test('NetEase malformed account responses remain temporary and preserve the authorized session', async () => {
  const f = fixture(); await authorize(f);
  for (const body of [{ code: 200 }, { code: 200, profile: { userId: 'broken' } }, { code: 502, profile: null }]) {
    f.setStatusBody(body); const failure = await plugin.roots(f.ctx);
    expect(failure).toMatchObject({ ok: false, error: { kind: 'temporary' } });
    expect(failure.nextPrivateState).toBeUndefined();
    expect(f.ctx.privateState).toMatchObject({ accountId: '42', accountName: '测试账号' });
  }
  f.setStatusBody({ code: 200, profile: { userId: 42, nickname: '测试账号' } });
  expect(value(await plugin.roots(f.ctx)).items).toHaveLength(5);
});

test('NetEase an explicit logged-out account removes the rejected credential while preserving its device and independent QR challenge', async () => {
  const f = fixture(); await authorize(f);
  const started = await plugin.authenticate!(f.ctx, { kind: 'start' }); const qr = waiting(value(started)); f.ctx.privateState = started.nextPrivateState!;
  f.setStatusBody({ code: 200, account: null, profile: null });
  const failure = await plugin.roots(f.ctx);
  expect(failure).toMatchObject({ ok: false, error: { kind: 'needs_auth' }, nextPrivateState: { accountId: null, accountName: null, pending: { id: qr.challengeId } } });
  expect(JSON.stringify(failure.nextPrivateState)).not.toContain('private-session'); expect(JSON.stringify(failure.nextPrivateState)).toContain('deviceId');
  f.ctx.privateState = failure.nextPrivateState!;
  const before = f.calls.length; expect(await plugin.roots(f.ctx)).toMatchObject({ ok: false, error: { kind: 'needs_auth' } }); expect(f.calls).toHaveLength(before);
  f.setStatusBody({ code: 200, profile: { userId: 42, nickname: '测试账号' } });
  const completed = await plugin.authenticate!(f.ctx, { kind: 'poll', challengeId: qr.challengeId }); expect(value(completed).kind).toBe('complete'); f.ctx.privateState = completed.nextPrivateState!;
  expect(value(await plugin.list(f.ctx, 'created')).items.map(item => item.name)).toEqual(['自建歌单']);
});

test('NetEase response cookie updates survive a later business failure and are reused after restoring the proposal', async () => {
  const f = fixture(); await authorize(f); const originalFetch = f.ctx.fetch; let cookieAtFailure = '';
  f.ctx.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const path = new URL(request.url).pathname;
    if (path === '/eapi/v6/playlist/detail') {
      cookieAtFailure = request.headers.get('cookie') ?? '';
      const headers = new Headers(); headers.append('Set-Cookie', '__csrf=rotated-csrf; Domain=.music.163.com; Path=/; Secure');
      return Response.json({ code: 503 }, { status: 503, headers });
    }
    const response = await originalFetch(input, init);
    if (path === '/weapi/user/playlist') response.headers.append('Set-Cookie', 'MUSIC_U=rotated-session; Domain=.music.163.com; Path=/; HttpOnly; Secure; Expires=Thu, 31 Dec 2099 23:59:59 GMT');
    return response;
  }, { preconnect: fetch.preconnect });
  const failure = await plugin.list(f.ctx, 'liked');
  expect(failure).toMatchObject({ ok: false, error: { kind: 'temporary' }, nextPrivateState: { accountId: '42', accountName: '测试账号' } });
  expect(cookieAtFailure).toContain('MUSIC_U=rotated-session'); expect(cookieAtFailure).not.toContain('private-session');
  expect(JSON.stringify(failure.nextPrivateState)).toContain('rotated-csrf');
  f.ctx.privateState = failure.nextPrivateState!; f.ctx.fetch = originalFetch;
  expect(value(await plugin.roots(f.ctx)).items).toHaveLength(5);
  expect(f.calls.at(-1)!.cookie).toContain('MUSIC_U=rotated-session'); expect(f.calls.at(-1)!.cookie).toContain('__csrf=rotated-csrf');
});

test('NetEase cancellation discards only the matching local challenge', async () => {
  const f = fixture(); const start = await plugin.authenticate!(f.ctx, { kind: 'start' }); const qr = waiting(value(start)); f.ctx.privateState = start.nextPrivateState!;
  const cancelled = await plugin.authenticate!(f.ctx, { kind: 'cancel', challengeId: qr.challengeId }); expect(value(cancelled)).toEqual({ kind: 'cancelled' });
  f.ctx.privateState = cancelled.nextPrivateState!;
  expect(await plugin.authenticate!(f.ctx, { kind: 'poll', challengeId: qr.challengeId })).toMatchObject({ ok: false, error: { kind: 'invalid_config' } });
});

test('NetEase uses native collection roles and occurrence order, hides previews and keeps short-lived URLs private', async () => {
  const f = fixture(); await authorize(f);
  expect(value(await plugin.list(f.ctx, 'created')).items.map(item => item.name)).toEqual(['自建歌单']);
  expect(value(await plugin.list(f.ctx, 'favorites')).items.map(item => item.name)).toEqual(['收藏歌单']);
  const liked = value(await plugin.list(f.ctx, 'liked'));
  expect(liked.statistics).toMatchObject({ tracks: 3, files: 2, hiddenTracks: 1 });
  expect(liked.items.map(item => item.entryId)).toEqual(['1:1:standard', '3:1:standard']);
  expect(JSON.stringify(liked)).not.toContain('temporary-');
});

test('NetEase legacy references retain raw stat and ranges while tagged entries describe their final bytes', async () => {
  const f = fixture(); await authorize(f); f.ctx.fileInfo = 'required';
  const listed = value(await plugin.list(f.ctx, 'daily')); const file = listed.items[0]!;
  if (file.kind !== 'file') throw new Error('Expected a file');
  const description = value(await plugin.stat(f.ctx, file.fileRef)); expect(description.size).toBeGreaterThan(bytes.length); expect(file.info).toEqual(description);
  const legacy = JSON.stringify(JSON.parse(file.fileRef).source);
  const raw = value(await plugin.stat(f.ctx, legacy)); expect(raw.size).toBe(bytes.length); expect(f.cancelledBody()).toBe(true);
  const opened = value(await plugin.open(f.ctx, legacy, { expectedContentId: raw.contentId, range: { start: 4, end: 8 } }));
  const reader = opened.body.getReader(); expect((await reader.read()).value).toEqual(bytes.slice(4, 9)); await reader.cancel();
  expect(opened.servedRange).toEqual({ start: 4, end: 8 });
  const full = value(await plugin.open(f.ctx, legacy, { expectedContentId: raw.contentId }));
  expect(new Uint8Array(await new Response(full.body).arrayBuffer())).toEqual(bytes);
  expect(f.calls.filter(call => call.path.endsWith('/1.mp3')).every(call => call.cookie === '')).toBe(true);
  f.setBrokenVersion(true); expect(await plugin.open(f.ctx, legacy, { expectedContentId: raw.contentId })).toMatchObject({ ok: false, error: { kind: 'content_changed' } });
});

test('NetEase liked pages locate once per instance while retaining order, repeated positions, old cursors and sequence checks', async () => {
  const f = fixture(); await authorize(f); f.ctx.fileInfo = 'required'; f.setPreview(false); f.setPlaylistIds([...Array.from({ length: 8 }, (_, i) => i + 1), 1]);
  delete f.ctx.cache!.getMany; // Older hosts use the small compatibility checkpoint policy.
  const initialCalls = f.calls.length;
  const first = value(await plugin.list(f.ctx, 'liked')); expect(first.items).toHaveLength(8); expect(first.nextCursor).toBeDefined();
  expect(f.calls.length - initialCalls).toBeGreaterThan(4); const beforeSecond = f.calls.length;
  const last = value(await plugin.list(f.ctx, 'liked', first.nextCursor)); expect(last.items).toHaveLength(1); expect(last.items[0]!.entryId).toBe('9:1:standard'); expect(last.nextCursor).toBeUndefined();
  expect(f.calls.length - beforeSecond).toBe(1);
  expect(f.calls.filter(call => call.path.endsWith('/user/playlist'))).toHaveLength(1); expect(f.playlistCalls).toEqual(['8', '8']);
  expect((first.statistics?.tracks ?? 0) + (last.statistics?.tracks ?? 0)).toBe(9);

  const legacy = JSON.parse(first.nextCursor!) as Record<string, unknown>; delete legacy.likedPlaylistId; delete legacy.instanceId; delete legacy.scanId;
  const beforeLegacy = f.calls.length;
  expect(value(await plugin.list(f.ctx, 'liked', JSON.stringify(legacy))).items[0]!.entryId).toBe('9:1:standard');
  expect(f.calls.length - beforeLegacy).toBe(5); expect(f.calls.filter(call => call.path.endsWith('/user/playlist'))).toHaveLength(2);
  f.setPlaylistIds(Array.from({ length: 9 }, (_, i) => 9 - i));
  expect(await plugin.list(f.ctx, 'liked', first.nextCursor)).toMatchObject({ ok: false, error: { kind: 'content_changed' } });
  expect(f.calls.filter(call => call.path.endsWith('/user/playlist'))).toHaveLength(2);

  const other = fixture(); delete other.ctx.cache!.getMany; other.ctx.fileInfo = 'required'; other.ctx.instanceId = 'netease-b'; other.setLikedPlaylistId(18); await authorize(other); other.setPreview(false);
  other.setPlaylistIds(Array.from({ length: 9 }, (_, i) => i + 201));
  const beforeForeign = other.calls.length;
  expect(await plugin.list(other.ctx, 'liked', first.nextCursor)).toMatchObject({ ok: false, error: { kind: 'invalid_config' } }); expect(other.calls).toHaveLength(beforeForeign);
  const otherFirst = value(await plugin.list(other.ctx, 'liked'));
  expect(value(await plugin.list(other.ctx, 'liked', otherFirst.nextCursor)).items[0]!.entryId).toBe('9:209:standard');
  expect(other.calls.filter(call => call.path.endsWith('/user/playlist'))).toHaveLength(1); expect(other.playlistCalls).toEqual(['18', '18']);
});

test('NetEase rejects incomplete native collections and incomplete playback batches', async () => {
  const f = fixture(); await authorize(f); f.setWrongTrackCount(true);
  expect(await plugin.list(f.ctx, 'liked')).toMatchObject({ ok: false, error: { kind: 'temporary' } });
  f.setWrongTrackCount(false); f.setMissingPlayback(true);
  expect(await plugin.list(f.ctx, 'liked')).toMatchObject({ ok: false, error: { kind: 'temporary' } });
});

test('NetEase selects the requested level from 102 native rows for 100 IDs and still rejects conflicting or incomplete responses', async () => {
  const f = fixture(); await authorize(f); f.setPreview(false); f.setPlaylistIds(Array.from({ length: 100 }, (_, index) => index + 1));
  // Sanitized shape of the observed second page: 100 distinct requested IDs,
  // 102 response rows: the extra entries are other actual levels for two IDs,
  // with distinct format, checksum, length, trial information and short URL.
  const alternateLevels = (rows: Record<string, unknown>[]) => [...rows,
    { ...rows[21]!, level: 'lossless', type: 'FLAC', md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', size: 32, url: 'https://m1.music.126.net/other/22.flac' },
    { ...rows[73]!, level: 'lossless', type: 'FLAC', md5: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', size: 64, url: 'https://m1.music.126.net/other/74.flac', freeTrialInfo: { start: 0, end: 30 } }
  ];
  f.setPlaybackRows(alternateLevels);
  const ids = Array.from({ length: 100 }, (_, index) => String(index + 1));
  const resolve = () => resolveMedia(new NeteaseClient(f.ctx), ids, 'standard');
  expect((await resolve()).size).toBe(100);
  f.setPlaybackRows(rows => alternateLevels(rows.map(row => ({ ...row, type: 'MP3' }))));
  const uppercase = await resolve(); expect(uppercase.size).toBe(100);
  expect([...uppercase.values()].every(item => item.reference.type === 'mp3')).toBe(true);
  f.setPlaybackRows(rows => [...rows, { ...rows[21]!, url: 'https://m2.music.126.net/another-locator/22.mp3' }]);
  expect((await resolve()).size).toBe(100);
  f.setPlaybackRows(rows => rows.map((row, index) => index ? row : { ...row, level: 'lossless', type: 'FLAC' }));
  expect((await resolve()).size).toBe(99);
  f.setPlaybackRows(rows => [...rows, { ...rows[21]!, md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]);
  expect(resolve()).rejects.toMatchObject({ fault: { kind: 'temporary' } });
  f.setPlaybackRows(rows => [...rows, { ...rows[21]!, id: 101 }]);
  expect(resolve()).rejects.toMatchObject({ fault: { kind: 'temporary' } });
  f.setPlaybackRows(rows => rows.slice(1));
  expect(resolve()).rejects.toMatchObject({ fault: { kind: 'temporary' } });
});

test('NetEase forwards the caller abort to the actual Fetch request', async () => {
  const f = fixture(); const controller = new AbortController(); f.ctx.signal = controller.signal;
  f.ctx.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    expect(init?.signal).toBe(controller.signal); init!.signal!.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  }), { preconnect: fetch.preconnect });
  const operation = plugin.authenticate!(f.ctx, { kind: 'start' }); const reason = new DOMException('cancelled', 'AbortError'); controller.abort(reason);
  await expect(operation).rejects.toBe(reason);
});

test('NetEase validates per-instance audio policies and preserves legacy exhigh as single hide', async () => {
  const f = fixture();
  expect(value(await plugin.validateConfig(f.ctx, { quality: 'exhigh' }))).toEqual({ label: '网易云音乐', quality: 'exhigh', audio: { mode: 'single', qualities: ['standard'], missingQuality: 'hide' } });
  for (const invalid of [{ quality: ['lossless', 'exhigh'] }, audio([]), audio(['standard', 'standard']), audio(['unknown']), audio(['standard'], 'ignore'), { quality: 'unknown' }]) {
    expect(await plugin.validateConfig(f.ctx, invalid)).toMatchObject({ ok: false, error: { kind: 'invalid_config' } });
  }
  const first = value(await plugin.validateConfig(f.ctx, {})) as { audio: { qualities: string[] } }; first.audio.qualities.push('exhigh');
  expect(value(await plugin.validateConfig(f.ctx, {}))).toMatchObject({ audio: { qualities: ['standard'] } });
});

test('NetEase legacy single quality and multiple targets remain independent through the public plugin interface', async () => {
  const f = await qualityFixture(); f.ctx.config = value(await plugin.validateConfig(f.ctx, { quality: 'exhigh' }));
  f.available.set('1:exhigh', { level: 'exhigh' }); f.available.set('1:lossless', { level: 'lossless' }); f.available.set('1:standard', { level: 'standard' });
  expect(value(await plugin.list(f.ctx, 'liked')).items.map(item => item.entryId)).toEqual(['1:1:exhigh', '3:1:exhigh']);
  f.ctx.config = value(await plugin.validateConfig(f.ctx, { quality: 'exhigh', audio: { mode: 'multiple', qualities: ['lossless', 'standard'], missingQuality: 'hide' } }));
  expect(value(await plugin.list(f.ctx, 'liked')).items.map(item => item.entryId)).toEqual(['1:1:lossless', '1:1:standard', '3:1:lossless', '3:1:standard']);
});

test('NetEase fallback merges targets landing on one actual file while retaining repeated occurrences and additive statistics', async () => {
  const f = await qualityFixture(); f.ctx.config = audio(['lossless', 'exhigh'], 'fallback'); f.available.set('1:exhigh', { level: 'exhigh' });
  const page = value(await plugin.list(f.ctx, 'liked'));
  expect(page.items.map(item => item.entryId)).toEqual(['1:1:exhigh', '3:1:exhigh']);
  expect(page.items.every(item => item.name.endsWith('[极高].mp3'))).toBe(true);
  expect(page.statistics).toEqual({ tracks: 3, files: 2, hiddenTracks: 1, missingVersions: 2, fallbackVersions: 2, deduplicatedVersions: 2 });
  expect(f.playbackCalls).toEqual([{ ids: [1, 2], level: 'lossless' }, { ids: [1, 2], level: 'exhigh' }, { ids: [2], level: 'standard' }]);
  expect(JSON.stringify(page)).not.toContain('temporary/');
});

test('NetEase hide preserves distinct selected files and multiple versions do not multiply the source track count', async () => {
  const f = await qualityFixture(); f.ctx.config = audio(['lossless', 'exhigh']);
  f.available.set('1:lossless', { level: 'lossless' }); f.available.set('1:exhigh', { level: 'exhigh' });
  const page = value(await plugin.list(f.ctx, 'liked'));
  expect(page.items.map(item => item.entryId)).toEqual(['1:1:lossless', '1:1:exhigh', '3:1:lossless', '3:1:exhigh']);
  expect(page.items.map(item => item.name.slice(item.name.lastIndexOf('[')))).toEqual(['[无损].flac', '[极高].mp3', '[无损].flac', '[极高].mp3']);
  expect(page.statistics).toEqual({ tracks: 3, files: 4, hiddenTracks: 1, missingVersions: 2, fallbackVersions: 0, deduplicatedVersions: 0 });
});

test('NetEase accepts native actual downgrades only under fallback and never changes a referenced file during reads', async () => {
  const f = await qualityFixture(); f.setPlaylistIds([1]); f.available.set('1:lossless', { level: 'exhigh' }); f.available.set('1:exhigh', { level: 'exhigh' });
  f.ctx.config = audio(['lossless']); expect(value(await plugin.list(f.ctx, 'liked')).items).toEqual([]);
  f.ctx.config = audio(['lossless'], 'fallback'); const page = value(await plugin.list(f.ctx, 'liked'));
  expect(page.statistics).toMatchObject({ tracks: 1, files: 1, fallbackVersions: 1 }); expect(page.items[0]!.name).toContain('[极高].mp3');
  const file = page.items[0]!; if (file.kind !== 'file') throw new Error('Expected file');
  const content = value(await plugin.stat(f.ctx, file.fileRef)); f.available.delete('1:exhigh'); f.available.set('1:standard', { level: 'standard' });
  for (const [key, saved] of (f.ctx.cache as ReturnType<typeof memoryCache>).values) if (key.startsWith('versions:')) saved.expiresAt = 0;
  const before = f.playbackCalls.length;
  expect(await plugin.open(f.ctx, file.fileRef, { expectedContentId: content.contentId })).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
  expect(f.playbackCalls.slice(before)).toEqual([{ ids: [1], level: 'exhigh' }]);
});

test('NetEase excludes every preview in a fallback chain and does not treat temporary, auth, rate or format faults as unavailable qualities', async () => {
  const preview = await qualityFixture(); preview.setPlaylistIds([1]); preview.ctx.config = audio(['lossless'], 'fallback');
  for (const level of ['lossless', 'exhigh', 'standard']) preview.available.set(`1:${level}`, { level, preview: true });
  expect(value(await plugin.list(preview.ctx, 'liked')).statistics).toMatchObject({ tracks: 1, files: 0, hiddenTracks: 1, missingVersions: 1 });
  for (const [status, code, kind] of [[503, 503, 'temporary'], [429, 429, 'rate_limited'], [200, 301, 'needs_auth']] as const) {
    const f = await qualityFixture(); f.setPlaylistIds([1]); f.ctx.config = audio(['lossless'], 'fallback'); f.available.set('1:standard', { level: 'standard' });
    const nativeFetch = f.ctx.fetch; let playback = 0;
    f.ctx.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(input instanceof Request ? input.url : input).pathname === '/eapi/song/enhance/player/url/v1') { playback++; return Response.json({ code }, { status }); }
      return nativeFetch(input, init);
    }, { preconnect: fetch.preconnect });
    expect(await plugin.list(f.ctx, 'liked')).toMatchObject({ ok: false, error: { kind } }); expect(playback).toBe(1);
  }
  const unknown = await qualityFixture(); unknown.setPlaylistIds([1]); unknown.ctx.config = audio(['lossless'], 'fallback');
  unknown.available.set('1:lossless', { level: 'lossless', type: 'OGG' }); unknown.available.set('1:standard', { level: 'standard' });
  expect(await plugin.list(unknown.ctx, 'liked')).toMatchObject({ ok: false, error: { kind: 'temporary' } }); expect(unknown.playbackCalls).toHaveLength(1);
});

test('NetEase prepares album positions, cover and three lyric forms once, and cache-only stat matches final streamed bytes', async () => {
  const f = fixture(); await authorize(f); f.ctx.fileInfo = 'required'; f.setPlaylistIds([1, 1]); f.setPreview(false);
  const jpeg = new Uint8Array(await Bun.file(new URL('./fixtures/source-metadata/cover.jpg', import.meta.url)).arrayBuffer());
  const native = f.ctx.fetch; const counts = { album: 0, lyrics: 0, cover: 0 };
  f.ctx.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith('/song/detail/')) return Response.json({ code: 200, songs: [{ id: 1, name: '来源歌名', artists: [{ name: '第一歌手' }, { name: '第二歌手' }],
      album: { id: 55, name: '来源专辑', picUrl: 'https://p1.music.126.net/cover.jpg' }, no: 7, disc: '2' }] });
    if (url.pathname.endsWith('/v1/album/55')) { counts.album++; return Response.json({ code: 200, album: { id: 55, artists: [{ name: '专辑歌手' }], publishTime: Date.UTC(2020, 1, 2, 16), size: 12 } }); }
    if (url.pathname.endsWith('/song/lyric/v1')) counts.lyrics++;
    if (url.hostname === 'p1.music.126.net') { expect(url.searchParams.get('param')).toBe('500y500'); counts.cover++; return new Response(jpeg, { headers: { 'Content-Type': 'image/jpg' } }); }
    return native(input, init);
  }) as typeof fetch;
  const listed = value(await plugin.list(f.ctx, 'liked')); expect(listed.items).toHaveLength(2);
  const entry = listed.items[0]!; if (entry.kind !== 'file') throw new Error('Expected file');
  expect(listed.items[1]?.kind === 'file' && listed.items[1].fileRef).toBe(entry.fileRef);
  expect(counts).toEqual({ album: 1, lyrics: 1, cover: 1 });
  const info = value(await plugin.stat(f.ctx, entry.fileRef)); expect(info).toEqual(entry.info!);
  const full = value(await plugin.open(f.ctx, entry.fileRef, { expectedContentId: info.contentId }));
  const bytes = new Uint8Array(await new Response(full.body).arrayBuffer()); expect(bytes.length).toBe(info.size);
  const tag = parseId3(bytes);
  expect(tag.title).toBe('来源歌名'); expect(tag.performers).toEqual(['第一歌手', '第二歌手']); expect(tag.album).toBe('来源专辑');
  expect(tag.albumArtists).toEqual(['专辑歌手']); expect(tag.getTextAsString(Id3v2FrameIdentifiers.TYER!)).toBe('2020'); expect(tag.getTextAsString(Id3v2FrameIdentifiers.TDAT!)).toBe('0302');
  expect(tag.track).toBe(7); expect(tag.trackCount).toBe(12); expect(tag.disc).toBe(2); expect(tag.pictures).toHaveLength(1);
  expect(tag.pictures[0]!.mimeType).toBe('image/jpeg'); expect(tag.pictures[0]!.data.toByteArray()).toEqual(jpeg);
  const lyrics = tag.getFramesByClassType<Id3v2UnsynchronizedLyricsFrame>(Id3v2FrameClassType.UnsynchronizedLyricsFrame);
  expect(lyrics.map(frame => [frame.description, frame.text])).toEqual([['', '[00:00.00]原文'], ['translation', '[00:00.00]译文'], ['romanization', '[00:00.00]Romanization']]);
  const range = { start: info.size - 64, end: info.size - 1 };
  const partial = value(await plugin.open(f.ctx, entry.fileRef, { expectedContentId: info.contentId, range }));
  expect(new Uint8Array(await new Response(partial.body).arrayBuffer())).toEqual(bytes.slice(range.start));
  expect(counts).toEqual({ album: 1, lyrics: 1, cover: 1 });
  const cancellable = value(await plugin.open(f.ctx, entry.fileRef, { expectedContentId: info.contentId }));
  const upstreamSignal = f.calls.at(-1)!.signal!;
  expect(upstreamSignal.aborted).toBe(false); await cancellable.body.cancel();
  expect(upstreamSignal.aborted).toBe(true); expect(f.ctx.signal.aborted).toBe(false);
  const legacy = JSON.stringify({ version: 2, source: JSON.parse(entry.fileRef).source, planKey: `tag-plan:${info.contentId}` });
  expect(value(await plugin.stat(f.ctx, legacy))).toEqual(info);
  const cache = f.ctx.cache as ReturnType<typeof memoryCache>; cache.values.delete(`tag-plan:${info.contentId}`);
  expect(await plugin.stat(f.ctx, legacy)).toMatchObject({ ok: false, error: { kind: 'temporary' } });
});

test('NetEase new listings require the optional host cache instead of silently publishing untagged audio', async () => {
  const f = fixture(); await authorize(f); delete f.ctx.cache;
  expect(await plugin.list(f.ctx, 'daily')).toMatchObject({ ok: false, error: { kind: 'not_supported' } });
});

test('NetEase stable auxiliary metadata lasts one year while missing lyrics are retried after thirty days', async () => {
  for (const missing of [false, true]) {
    const f = fixture(); await authorize(f); f.ctx.fileInfo = 'required'; const request = f.ctx.fetch;
    if (missing) f.ctx.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith('/song/lyric/v1')) return Response.json({ code: 200 });
      return request(input, init);
    }, { preconnect: fetch.preconnect });
    const before = Date.now(); value(await plugin.list(f.ctx, 'daily'));
    const cached = (f.ctx.cache as ReturnType<typeof memoryCache>).values.get('lyrics:1')!;
    const remaining = cached.expiresAt! - before;
    expect(remaining).toBeGreaterThanOrEqual((missing ? 30 : 365) * 24 * 60 * 60_000);
    expect(remaining).toBeLessThan((missing ? 30 : 365) * 24 * 60 * 60_000 + 2000);
  }
});

test('NetEase preserves Retry-After for HTTP and business rate limits without invalidating the session', async () => {
  for (const status of [200, 429]) {
    const f = fixture(); await authorize(f);
    f.ctx.fetch = Object.assign(async () => Response.json({ code: 429 }, { status, headers: { 'retry-after': '9' } }), { preconnect: fetch.preconnect });
    expect(await plugin.list(f.ctx, 'created')).toMatchObject({ ok: false, error: { kind: 'rate_limited', retryAfterSeconds: 9 } });
    expect(JSON.stringify(f.ctx.privateState)).toContain('private-session');
  }
});

test('NetEase actual FLAC and M4A representations keep exact tagged sizes and final-file byte ranges', async () => {
  for (const [level, type, mediaType] of [['lossless', 'FLAC', 'audio/flac'], ['standard', 'M4A', 'audio/mp4']] as const) {
    const f = await qualityFixture(); f.ctx.fileInfo = 'required'; f.setPlaylistIds([1]); f.ctx.config = audio([level]); f.available.set(`1:${level}`, { level, type });
    const entry = value(await plugin.list(f.ctx, 'liked')).items[0]!; if (entry.kind !== 'file' || !entry.info) throw new Error('Expected prepared audio');
    expect(entry.name.toLowerCase()).toEndWith('.' + type.toLowerCase()); expect(entry.info.mediaType).toBe(mediaType);
    const full = value(await plugin.open(f.ctx, entry.fileRef, { expectedContentId: entry.info.contentId }));
    const bytes = new Uint8Array(await new Response(full.body).arrayBuffer()); expect(bytes.length).toBe(entry.info.size);
    const range = { start: entry.info.size - 64, end: entry.info.size - 1 };
    const partial = value(await plugin.open(f.ctx, entry.fileRef, { expectedContentId: entry.info.contentId, range }));
    expect(new Uint8Array(await new Response(partial.body).arrayBuffer())).toEqual(bytes.slice(range.start));
  }
});
