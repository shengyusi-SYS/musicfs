import { expect, test } from 'bun:test';
import { parseBuffer } from 'music-metadata';
import type { Entry, Json, PluginCache } from '@musicfs/plugin-api';
import { list } from '../plugins/netease/catalog';
import type { NeteaseClient } from '../plugins/netease/client';
import { endpoints } from '../plugins/netease/generated-upstream.mjs';
import { open, stat } from '../plugins/netease/media';
import { cover, parseId3, Id3v2FrameClassType, type Id3v2UnsynchronizedLyricsFrame } from '../packages/audio-tags/test-fixtures';
import { mediaBytes, memoryCache } from './helpers/source-metadata';

type Format = 'mp3' | 'flac' | 'm4a';
const reserveBytes = 1_048_576;
const bodyBytes = async (body: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(body).arrayBuffer());
const file = (entry: Entry | undefined) => { if (entry?.kind !== 'file' || !entry.info) throw new Error('Expected exact file entry'); return entry; };

/** Real source media and public plugin operations, with all transport/cache work confined to memory. */
function fixture(format: Format) {
  const stored = memoryCache(); const calls: Record<string, number> = {}; let reservations = 0;
  let playlist = [1, 2];
  let lyric = '[00:00.00]原文\n[00:00.50]第二行\n'; let image = cover;
  const cache: PluginCache & { values: typeof stored.values } = { ...stored,
    async put(key, value, options) {
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_048_576) throw new Error('Plugin cache value exceeds 1 MiB');
      await stored.put(key, value, options);
    },
    async putMany(items) { for (const item of items) await cache.put(item.key, item.value, item.expiresAt === undefined ? undefined : { expiresAt: item.expiresAt }); },
    async putIfAbsent(key, value) {
      const saved = stored.values.get(key);
      if (saved && (saved.expiresAt === undefined || saved.expiresAt > Date.now())) return structuredClone(saved.value);
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_048_576) throw new Error('Plugin cache value exceeds 1 MiB');
      stored.values.set(key, { value: structuredClone(value) }); reservations++; return structuredClone(value);
    },
  };
  const bytes = mediaBytes[format]; const hit = (key: string) => { calls[key] = (calls[key] ?? 0) + 1; };
  const song = (id: number) => ({ id, name: `中文歌曲 ${id}`, artists: [{ name: '歌手甲' }, { name: '歌手乙' }],
    album: { id: 1, name: '专辑', picUrl: 'https://p1.music.126.net/reserved.png', artists: [{ name: '专辑歌手' }], publishTime: 1577836800000, size: 2 }, no: id, disc: '1' });
  const createClient = () => ({
    ctx: { instanceId: 'reserved-offline', config: { quality: 'standard' }, signal: new AbortController().signal, cache,
      async fetch(input: string | URL, init?: RequestInit) {
        const url = new URL(String(input));
        if (url.hostname === 'p1.music.126.net') { hit('cover'); return new Response(image, { headers: { 'content-type': 'image/png' } }); }
        expect(url.hostname).toBe('m1.music.126.net'); hit('range');
        const ranges = new Headers(init?.headers).get('range')!.slice(6).split(',').map(value => {
          const [start, end] = value.split('-').map(Number); return { start: start!, end: end! };
        });
        if (ranges.length > 1) {
          const boundary = 'offline-reserved-ranges';
          const parts = ranges.flatMap(range => [`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${range.start}-${range.end}/${bytes.length}\r\n\r\n`, bytes.slice(range.start, range.end + 1), '\r\n']);
          const body = new Uint8Array(await new Blob([...parts, `--${boundary}--\r\n`]).arrayBuffer());
          return new Response(body, { status: 206, headers: { 'content-length': String(body.length), 'content-type': `multipart/byteranges; boundary=${boundary}` } });
        }
        const { start, end } = ranges[0]!;
        return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${bytes.length}` } });
      } },
    state: { accountId: '42' }, requireSession() {},
    async call(endpoint: unknown, params: Record<string, Json> = {}) {
      if (endpoint === endpoints.daily) { hit('daily'); return { data: { dailySongs: playlist.map(song) } }; }
      if (endpoint === endpoints.userPlaylists) { hit('user'); return { playlist: [{ id: 900, userId: 42, specialType: 5, name: '喜欢的音乐' }], more: false }; }
      if (endpoint === endpoints.playlist) { hit('playlist'); return { playlist: { trackIds: playlist.map(id => ({ id })), trackCount: playlist.length, tracks: [] } }; }
      if (endpoint === endpoints.songs) { hit('details'); return { songs: String(params.ids).split(',').map(id => song(Number(id))) }; }
      if (endpoint === endpoints.playback) { hit('playback'); return { data: String(params.id).split(',').map(id => ({ id: Number(id), url: `https://m1.music.126.net/${id}.${format}`, expi: 1200, level: params.level, type: format, md5: Number(id).toString(16).padStart(32, '0'), size: bytes.length })) }; }
      if (endpoint === endpoints.lyric) { hit('lyrics'); return { lrc: { lyric }, tlyric: { lyric: '[00:00.00]Translation' }, romalrc: { lyric: '[00:00.00]Romanization' } }; }
      throw new Error('Unexpected offline endpoint');
    },
  }) as unknown as NeteaseClient;
  return { client: createClient(), cache, calls, bytes, get reservations() { return reservations; }, reopen: createClient,
    playlist(ids: number[]) { playlist = ids; },
    reset() { for (const key of Object.keys(calls)) delete calls[key]; },
    lyrics(value: string) { lyric = value; }, picture(value: Uint8Array) { image = new Uint8Array(value); },
    expire(prefix: string) { for (const [key, item] of stored.values) if (key.startsWith(prefix)) item.expiresAt = 0; } };
}

test('unopened NetEase files retain their representation across unchanged refresh, insertion and reorder', async () => {
  const f = fixture('mp3');
  const scan = async () => (await list(f.reopen(), 'liked')).items.map(file);
  const bySong = (items: ReturnType<typeof file>[]) => new Map(items.map(item => [JSON.parse(item.fileRef).source.id, item]));
  const first = bySong(await scan());
  const expiry = [...f.cache.values].filter(([key]) => key.startsWith('reservation:')).map(([key, value]) => [key, value.expiresAt]);
  expect(bySong(await scan())).toEqual(first);
  expect([...f.cache.values].filter(([key]) => key.startsWith('reservation:')).map(([key, value]) => [key, value.expiresAt])).toEqual(expiry);
  f.playlist([3, 1, 2]); const inserted = bySong(await scan());
  for (const id of ['1', '2']) {
    expect(inserted.get(id)?.fileRef).toBe(first.get(id)?.fileRef);
    expect(inserted.get(id)?.info).toEqual(first.get(id)?.info);
  }
  expect(inserted.get('1')?.name).not.toBe(first.get('1')?.name); // Keep the existing numbered ordering contract.
  f.playlist([2, 1, 3]); const reordered = bySong(await scan());
  for (const id of ['1', '2', '3']) expect(reordered.get(id)?.fileRef).toBe(inserted.get(id)?.fileRef);
  expect(f.calls.lyrics ?? 0).toBe(0); expect(f.calls.cover ?? 0).toBe(0); expect(f.calls.range ?? 0).toBe(0);
  expect(f.reservations).toBe(0);
});

test('an unopened reservation expires without preparing audio and never masquerades as a prepared file', async () => {
  const f = fixture('mp3');
  const first = file((await list(f.reopen(), 'liked')).items[0]);
  f.expire('reservation:');
  const next = file((await list(f.reopen(), 'liked')).items[0]);
  expect(next.info?.contentId).not.toBe(first.info?.contentId);
  expect(f.reservations).toBe(0); expect(f.calls.lyrics ?? 0).toBe(0); expect(f.calls.range ?? 0).toBe(0);
  const required = f.reopen(); required.ctx.fileInfo = 'required';
  const prepared = file((await list(required, 'liked')).items[0]);
  expect(JSON.parse(prepared.fileRef).version).toBe(2);
  expect(f.calls.lyrics).toBe(2); expect(f.calls.range).toBeGreaterThan(0);
  expect(file((await list(f.reopen(), 'liked')).items[0]).fileRef).toBe(prepared.fileRef);
});

test('permanent metadata policy also retains unopened reservation identities without a sliding expiry', async () => {
  const f = fixture('mp3'); f.client.ctx.config = { metadataCacheDays: 0 };
  const first = (await list(f.client, 'liked')).items;
  const reservations = [...f.cache.values].filter(([key]) => key.startsWith('reservation:'));
  expect(reservations).toHaveLength(2); expect(reservations.every(([, value]) => value.expiresAt === undefined)).toBe(true);
  expect((await list(f.client, 'liked')).items).toEqual(first);
  expect(f.reservations).toBe(0);
});

test('NetEase daily recommendations and a playlist share equal music facts despite SDK completeness markers', async () => {
  const f = fixture('mp3'); const liked = (await list(f.reopen(), 'liked')).items.map(file);
  const daily = (await list(f.reopen(), 'daily')).items.map(file);
  expect(daily.map(item => item.fileRef)).toEqual(liked.map(item => item.fileRef));
  expect(daily.map(item => item.info)).toEqual(liked.map(item => item.info));
  expect(f.calls.lyrics ?? 0).toBe(0); expect(f.calls.range ?? 0).toBe(0);
});

for (const format of ['mp3', 'flac', 'm4a'] as const) {
  test(`NetEase reserved ${format}: catalogue/stat need no preparation, one GET freezes one accurate tagged file`, async () => {
    const f = fixture(format); const page = await list(f.client, 'liked'); const first = file(page.items[0]); const second = file(page.items[1]);
    const info = first.info!;
    expect(info.size).toBe(f.bytes.length + reserveBytes); expect(first.deferredInfo).toBeUndefined();
    expect(JSON.parse(first.fileRef).version).toBe(4); expect(JSON.parse(second.fileRef).version).toBe(4);
    expect(f.calls).toEqual({ user: 1, playlist: 2, details: 1, playback: 1 }); expect(f.reservations).toBe(0);
    f.reset(); expect(await stat(f.client, first.fileRef)).toEqual(info); expect(f.calls).toEqual({});
    const opened = await open(f.client, first.fileRef, { expectedContentId: info.contentId }); const bytes = await bodyBytes(opened.body);
    expect(opened.content).toEqual(info); expect(bytes.length).toBe(info.size); expect(f.reservations).toBe(1);
    expect(f.calls.lyrics).toBe(1); expect(f.calls.cover).toBe(1); expect(f.calls.range).toBeGreaterThan(0);
    expect([...f.cache.values.keys()].filter(key => key.startsWith('reserved-plan:'))).toHaveLength(1);
    const parsed = await parseBuffer(bytes, { mimeType: info.mediaType, size: bytes.length });
    expect(parsed.common.title).toBe('中文歌曲 1'); expect(parsed.common.artists).toEqual(['歌手甲', '歌手乙']);
    expect(parsed.common.album).toBe('专辑'); expect(parsed.common.picture?.[0]?.data).toEqual(cover);
    expect(JSON.stringify(parsed.native)).toContain('Translation'); expect(JSON.stringify(parsed.native)).toContain('Romanization');
    expect(JSON.stringify(parsed.native)).toContain('原文');
    f.reset(); const reopened = f.reopen();
    const readAgain = await open(reopened, first.fileRef, { expectedContentId: info.contentId });
    expect(await bodyBytes(readAgain.body)).toEqual(bytes); expect(f.calls.lyrics).toBeUndefined(); expect(f.calls.cover).toBeUndefined(); expect(f.reservations).toBe(1);
    for (const range of [{ start: 0, end: 63 }, { start: Math.floor(bytes.length / 2), end: Math.floor(bytes.length / 2) + 31 }, { start: bytes.length - 64, end: bytes.length - 1 }]) {
      const result = await open(reopened, first.fileRef, { expectedContentId: info.contentId, range });
      expect(result.servedRange).toEqual(range); expect(result.content).toEqual(info);
      expect(await bodyBytes(result.body)).toEqual(bytes.slice(range.start, range.end + 1));
    }
    expect(f.reservations).toBe(1); f.reset(); expect(await stat(reopened, second.fileRef)).toEqual(second.info!); expect(f.calls).toEqual({});
  });
}

test('NetEase reserved ready entries survive warm scans; a fresh generation after TTL cannot replace old published bytes', async () => {
  const f = fixture('mp3'); const first = file((await list(f.client, 'liked')).items[0]); const info = first.info!;
  const before = await bodyBytes((await open(f.client, first.fileRef, { expectedContentId: info.contentId })).body);
  f.reset(); const warm = file((await list(f.reopen(), 'liked')).items[0]);
  expect(warm.fileRef).toBe(first.fileRef); expect(warm.info).toEqual(info); expect(f.calls).toEqual({ user: 1, playlist: 2 });
  f.expire('ready:'); f.expire('lyrics:'); f.lyrics('[00:00.00]新歌词'); f.reset(); const newer = f.reopen();
  const fresh = file((await list(newer, 'liked')).items[0]);
  expect(fresh.info!.size).toBe(info.size); expect(fresh.info!.contentId).not.toBe(info.contentId);
  expect(JSON.parse(fresh.fileRef).generation).not.toBe(JSON.parse(first.fileRef).generation);
  expect(f.calls).toEqual({ user: 1, playlist: 2 });
  expect(await bodyBytes((await open(newer, first.fileRef, { expectedContentId: info.contentId })).body)).toEqual(before);
  const after = await bodyBytes((await open(newer, fresh.fileRef, { expectedContentId: fresh.info!.contentId })).body);
  expect(parseId3(after).getFramesByClassType<Id3v2UnsynchronizedLyricsFrame>(Id3v2FrameClassType.UnsynchronizedLyricsFrame).some(frame => frame.text === '[00:00.00]新歌词')).toBe(true);
  expect(after).not.toEqual(before); expect(f.reservations).toBe(2);
  await expect(open(newer, fresh.fileRef, { expectedContentId: info.contentId })).rejects.toMatchObject({ fault: { kind: 'content_changed' } });
});

test('NetEase overbudget metadata rejects the advertised size and publishes an exact v2 file on the next scan without truncation', async () => {
  const f = fixture('mp3'); const oversizedCover = new Uint8Array(600_000); oversizedCover.set(cover); f.picture(oversizedCover);
  const lyrics = '[00:00.00]' + 'x'.repeat(270_000); f.lyrics(lyrics);
  const entry = file((await list(f.client, 'liked')).items[0]); const info = entry.info!;
  await expect(open(f.client, entry.fileRef, { expectedContentId: info.contentId })).rejects.toMatchObject({ fault: { kind: 'content_changed' } });
  expect(f.reservations).toBe(0);
  const exact = file((await list(f.reopen(), 'liked')).items[0]); expect(JSON.parse(exact.fileRef).version).toBe(2);
  expect(exact.info!.size).toBeGreaterThan(info.size); expect(exact.info!.contentId).not.toBe(info.contentId);
  const output = await bodyBytes((await open(f.reopen(), exact.fileRef, { expectedContentId: exact.info!.contentId })).body);
  expect(output.length).toBe(exact.info!.size);
  const tags = parseId3(output); expect(tags.pictures[0]?.data.toByteArray()).toEqual(oversizedCover);
  expect(tags.getFramesByClassType<Id3v2UnsynchronizedLyricsFrame>(Id3v2FrameClassType.UnsynchronizedLyricsFrame).some(frame => frame.text === lyrics)).toBe(true);
  await expect(open(f.reopen(), entry.fileRef, { expectedContentId: info.contentId })).rejects.toMatchObject({ fault: { kind: 'content_changed' } });
});
