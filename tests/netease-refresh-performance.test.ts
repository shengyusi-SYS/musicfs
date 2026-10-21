import { expect, test } from 'bun:test';
import type { Json } from '@musicfs/plugin-api';
import { list } from '../plugins/netease/catalog';
import { endpoints } from '../plugins/netease/generated-upstream.mjs';
import type { NeteaseClient } from '../plugins/netease/client';
import { mediaBytes, memoryCache } from './helpers/source-metadata';
import { cover, parseId3, Id3v2FrameClassType, type Id3v2UnsynchronizedLyricsFrame } from '../packages/audio-tags/test-fixtures';
import { open, stat } from '../plugins/netease/media';

function fixture(count: number, seed = 0) {
  const cache = memoryCache(); const bytes = mediaBytes.mp3;
  const calls: Record<string, number> = {}; const ids = Array.from({ length: count }, (_, i) => i + 1);
  let title = 'Song'; let playlist = [...ids]; let representation = 'original';
  const song = (id: number) => ({ id, name: `${title} ${id}`, ar: [{ name: 'Artist' }], al: { id: 1, name: 'Album', picUrl: 'https://p1.music.126.net/cover.png' }, no: id, cd: '1' });
  const richSong = (id: number) => ({ id, name: `${title} ${id}`, artists: [{ name: 'Artist' }],
    album: { id: 1, name: 'Album', picUrl: 'https://p1.music.126.net/cover.png', artists: [{ name: 'Artist' }], publishTime: 1577836800000, size: count }, no: id, disc: '1' });
  const hit = (key: string) => { calls[key] = (calls[key] ?? 0) + 1; };
  const client = {
    ctx: { instanceId: 'offline', config: { quality: 'standard' }, signal: new AbortController().signal, cache,
      async fetch(input: string | URL, init?: RequestInit) {
        const url = new URL(String(input));
        if (url.hostname === 'p1.music.126.net') { hit('cover'); return new Response(cover, { headers: { 'content-type': 'image/png' } }); }
        expect(url.hostname).toBe('m1.music.126.net'); hit('range');
        const ranges = new Headers(init?.headers).get('range')!.slice(6).split(',').map(value => {
          const [start, end] = value.split('-').map(Number); return { start: start!, end: end! };
        });
        if (ranges.length > 1) {
          const boundary = 'offline-refresh-ranges';
          const chunks = ranges.flatMap(range => [`--${boundary}\r\nContent-Type: audio/mpeg\r\nContent-Range: bytes ${range.start}-${range.end}/${bytes.length}\r\n\r\n`,
            bytes.slice(range.start, range.end + 1), '\r\n']);
          const body = new Uint8Array(await new Blob([...chunks, `--${boundary}--\r\n`]).arrayBuffer());
          return new Response(body, { status: 206, headers: { 'content-length': String(body.length), 'content-type': `multipart/byteranges; boundary=${boundary}` } });
        }
        const { start, end } = ranges[0]!;
        return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${bytes.length}` } });
      } },
    state: { accountId: '42' }, requireSession() {},
    async call(endpoint: unknown, params: Record<string, Json> = {}) {
      if (endpoint === endpoints.userPlaylists) { hit('user'); return { playlist: [{ id: 900, userId: 42, specialType: 5, name: 'Likes' }], more: false }; }
      if (endpoint === endpoints.playlist) { hit('playlist'); return { playlist: { trackIds: playlist.map(id => ({ id })), trackCount: playlist.length, tracks: playlist.slice(0, seed).map(song) } }; }
      if (endpoint === endpoints.songs) { hit('details'); return { songs: String(params.ids).split(',').map(id => richSong(Number(id))) }; }
      if (endpoint === endpoints.playback) { hit('playback'); return { data: String(params.id).split(',').map(id => ({ id: Number(id), url: `https://m1.music.126.net/${id}.mp3`, expi: 1200, level: params.level, type: 'mp3', md5: representation === 'original' ? Number(id).toString(16).padStart(32, '0') : 'f'.repeat(32), size: bytes.length })) }; }
      if (endpoint === endpoints.album) { hit('album'); return { album: { artist: { name: 'Artist' }, publishTime: 1577836800000, size: count } }; }
      if (endpoint === endpoints.lyric) { hit('lyrics'); return { lrc: { lyric: `[00:00.00]Lyrics ${params.id}` } }; }
      throw new Error('Unexpected local endpoint');
    }
  } as unknown as NeteaseClient;
  return { client, cache, calls, reset() { for (const key of Object.keys(calls)) delete calls[key]; },
    rename(value: string) { title = value; }, reorder() { playlist.reverse(); }, setPlaylist(value: number[]) { playlist = value; }, changeMedia() { representation = 'changed'; } };
}

test('large NetEase scans reuse one membership and 100-track native batches across cold checkpoints', async () => {
  const f = fixture(4000, 10); f.client.ctx.fileInfo = 'required';
  const seedBatches: string[][] = []; const putMany = f.cache.putMany!;
  f.cache.putMany = async items => {
    const seeds = items.filter(item => item.key.startsWith('tag-seed:')).map(item => item.key);
    if (seeds.length) seedBatches.push(seeds);
    await putMany(items);
  };
  const policy = { warmFiles: 100, concurrency: 2, coldFiles: 8 };
  const first = await list(f.client, 'liked', undefined, policy);
  expect(seedBatches.map(batch => batch.length)).toEqual([8]);
  expect([...f.cache.values.keys()].filter(key => key.startsWith('tag-seed:'))).toHaveLength(8);
  const second = await list(f.client, 'liked', first.nextCursor, policy);
  expect(seedBatches.map(batch => batch.length)).toEqual([8, 8]);
  expect(new Set(seedBatches.flat()).size).toBe(16);
  expect(first.statistics?.tracks).toBe(8); expect(second.statistics?.tracks).toBe(8);
  expect(f.calls.playlist).toBe(1); expect(f.calls.details).toBe(1); expect(f.calls.playback).toBe(1);
  expect(first.nextCursor).toBeDefined(); expect(second.nextCursor).not.toBe(first.nextCursor);
});

test('warm desktop refresh reuses prepared bytes in one larger page and notices membership and title changes', async () => {
  const f = fixture(24, 24); f.client.ctx.fileInfo = 'required'; let cursor: string | undefined;
  const original: string[] = [];
  do { const page = await list(f.client, 'liked', cursor); original.push(...page.items.map(item => JSON.stringify(item))); cursor = page.nextCursor; } while (cursor);
  f.reset();
  // The desktop policy only enlarges already prepared work; cold preparation remains bounded.
  const warm = await list(f.client, 'liked', undefined, { warmFiles: 100, concurrency: 2 });
  expect(warm.items.map(item => JSON.stringify(item))).toEqual(original); expect(warm.nextCursor).toBeUndefined();
  expect(f.calls).toEqual({ user: 1, playlist: 2 });
  f.reset(); f.rename('Updated');
  const changed = await list(f.client, 'liked', undefined, { warmFiles: 100, concurrency: 2, coldFiles: 8 }); expect(changed.items[0]?.name).toContain('Updated');
  expect(f.calls.lyrics ?? 0).toBe(0); expect(f.calls.range).toBeGreaterThan(0);
  f.reorder();
  await expect(list(f.client, 'liked', changed.nextCursor)).rejects.toMatchObject({ fault: { kind: 'content_changed' } });
});

test('4000-track lazy scans preserve membership and order without preparing audio or auxiliary metadata', async () => {
  const f = fixture(4000, 10);
  const scan = async () => {
    let cursor: string | undefined; let pages = 0; const entries: string[] = []; const files = [];
    do {
      const page = await list(f.client, 'liked', cursor); cursor = page.nextCursor; pages++;
      entries.push(...page.items.map(item => item.entryId)); files.push(...page.items);
      expect(page.progress?.completed).toBe(entries.length);
    } while (cursor);
    return { pages, entries, files };
  };
  const started = performance.now(); const cold = await scan(); const coldCalls = { ...f.calls };
  const coldMs = performance.now() - started; f.reset();
  const warmStart = performance.now(); const warm = await scan(); const warmMs = performance.now() - warmStart;
  expect(warm.pages).toBe(40); expect(warm.entries).toEqual(cold.entries); expect(warm.entries).toHaveLength(4000);
  expect(f.calls).toEqual({ user: 1, playlist: 2 });
  expect(coldCalls.playlist).toBe(2); expect(coldCalls.details).toBe(40); expect(coldCalls.playback).toBe(40);
  const warmCalls = { ...f.calls };
  expect(cold.pages).toBe(40);
  expect(coldCalls).toEqual({ user: 1, playlist: 2, details: 40, playback: 40 });
  expect(cold.files.every(item => item.kind === 'file' && item.info === undefined && item.deferredInfo === true)).toBe(true);
  const expiry = [...f.cache.values].filter(([key]) => key.startsWith('song:') || key.startsWith('versions:')).map(([key, item]) => [key, item.expiresAt]);
  f.reset(); f.setPlaylist([4001, ...Array.from({ length: 4000 }, (_, i) => i + 1)]);
  const added = await scan(); const addedCalls = { ...f.calls };
  expect(added.files).toHaveLength(4001);
  expect(addedCalls).toEqual({ user: 1, playlist: 2, details: 1, playback: 1 });
  expect(added.files[1]).toMatchObject({ deferredInfo: true });
  const movedFile = added.files[1]!; const originalFile = cold.files[0]!;
  expect(movedFile.kind === 'file' && movedFile.fileRef).toBe(originalFile.kind === 'file' && originalFile.fileRef);
  // Reusing rich facts does not renew their expiry, including sparse playlist seeds enriched on the first scan.
  const unchangedSong = (key: string) => key.startsWith('song:') && Number(key.slice(5)) >= 1 && Number(key.slice(5)) <= 4000;
  expect([...f.cache.values].filter(([key]) => unchangedSong(key)).map(([key, item]) => [key, item.expiresAt]))
    .toEqual(expiry.filter(([key]) => unchangedSong(String(key))));
  f.reset(); f.setPlaylist([...Array.from({ length: 4001 }, (_, i) => i + 1), 4002]);
  await scan(); const addedWithoutDetails = { ...f.calls };
  expect(addedWithoutDetails).toEqual({ user: 1, playlist: 2, details: 1, playback: 1 });
  f.reset(); f.setPlaylist(Array.from({ length: 4000 }, (_, i) => i + 1)); const removed = await scan();
  expect(removed.entries).toEqual(cold.entries); expect(f.calls).toEqual({ user: 1, playlist: 2 });
  f.reset();
  for (const [key, value] of f.cache.values) if (key.startsWith('versions:')) value.expiresAt = 0;
  await scan(); const expiredVersions = { ...f.calls };
  expect(expiredVersions).toEqual({ user: 1, playlist: 2, playback: 40 });
  f.reset();
  for (const [key, value] of f.cache.values) if (key.startsWith('song:') || key.startsWith('versions:')) value.expiresAt = 0;
  await scan(); const expiredBasics = { ...f.calls };
  expect(expiredBasics).toEqual({ user: 1, playlist: 2, details: 40, playback: 40 });
  const report = { scope: 'offline controlled transport, 4000 single-quality MP3 catalogue entries; no album, lyric, cover or audio reads; no platform HTTP',
    cold: { pages: cold.pages, calls: coldCalls, localHarnessMs: Math.round(coldMs) },
    warm: { pages: warm.pages, calls: warmCalls, localHarnessMs: Math.round(warmMs) },
    addedOne: { pages: added.pages, calls: addedCalls }, addedWithoutDetails: { calls: addedWithoutDetails }, removedAdded: { pages: removed.pages, calls: { user: 1, playlist: 2 } },
    expiredVersions: { calls: expiredVersions }, expiredBasics: { calls: expiredBasics } };
  if (process.env.MUSICFS_REFRESH_RESULT) await Bun.write(process.env.MUSICFS_REFRESH_RESULT, JSON.stringify(report, null, 2) + '\n');
}, 20_000);

test('lazy pages keep 100 source tracks when multiple qualities produce more than 100 files', async () => {
  const f = fixture(200, 0);
  f.client.ctx.config = { audio: { mode: 'multiple', qualities: ['lossless', 'standard'], missingQuality: 'hide' } };
  const first = await list(f.client, 'liked');
  expect(first.statistics).toMatchObject({ tracks: 100, files: 200, hiddenTracks: 0 });
  expect(first.progress).toEqual({ completed: 100, total: 200, unit: '曲目' });
  expect(first.nextCursor).toBeDefined();
  expect(f.calls).toEqual({ user: 1, playlist: 1, details: 1, playback: 2 });
  expect(first.items.every(item => item.kind === 'file' && item.deferredInfo === true)).toBe(true);
});

test('one lazy stat prepares only its persistent song descriptor and GET serves its exact tagged bytes', async () => {
  const f = fixture(4000, 10);
  const page = await list(f.client, 'liked'); const entry = page.items[0]!;
  if (entry.kind !== 'file') throw new Error('Expected a file');
  expect(page.items).toHaveLength(100); expect(entry.info).toBeUndefined(); expect(entry.deferredInfo).toBe(true);
  expect(f.calls).toEqual({ user: 1, playlist: 1, details: 1, playback: 1 });
  const ref = JSON.parse(entry.fileRef);
  expect(ref.version).toBe(3); expect(ref.descriptorKey).toStartWith('tag-seed:');
  expect([...f.cache.values.keys()].filter(key => key.startsWith('tag-seed:'))).toHaveLength(100);
  expect(JSON.stringify(ref)).not.toContain('Song'); expect(JSON.stringify(ref)).not.toContain('cover');
  expect(f.cache.values.get(ref.descriptorKey)?.expiresAt).toBeUndefined();
  for (const key of f.cache.values.keys()) if (key.startsWith('scan:') || key.startsWith('song:')) f.cache.values.delete(key);
  f.reset();
  const info = await stat(f.client, entry.fileRef);
  expect(info.size).toBeGreaterThan(mediaBytes.mp3.length);
  expect(f.calls).toEqual({ playback: 1, lyrics: 1, cover: 1, range: 1 });
  expect([...f.cache.values.keys()].filter(key => key.startsWith('ready:'))).toHaveLength(1);
  f.reset(); expect(await stat(f.client, entry.fileRef)).toEqual(info); expect(f.calls).toEqual({});
  const result = await open(f.client, entry.fileRef, { expectedContentId: info.contentId });
  const bytes = new Uint8Array(await new Response(result.body).arrayBuffer());
  expect(bytes.length).toBe(info.size); expect(result.content).toEqual(info);
  const tag = parseId3(bytes); expect(tag.title).toBe('Song 1'); expect(tag.pictures).toHaveLength(1);
  expect(tag.getFramesByClassType<Id3v2UnsynchronizedLyricsFrame>(Id3v2FrameClassType.UnsynchronizedLyricsFrame).map(frame => frame.text)).toEqual(['[00:00.00]Lyrics 1']);
  expect(f.calls).toEqual({ playback: 1, range: 1 });
  const range = { start: info.size - 64, end: info.size - 1 };
  const partial = await open(f.client, entry.fileRef, { expectedContentId: info.contentId, range });
  expect(partial.servedRange).toEqual(range);
  expect(new Uint8Array(await new Response(partial.body).arrayBuffer())).toEqual(bytes.slice(range.start));
});

test('required file information prepares complete files while lazy and warm references stay identical', async () => {
  const f = fixture(24, 24); const lazy = await list(f.client, 'liked');
  expect(f.calls).toEqual({ user: 1, playlist: 2, details: 1, playback: 1 });
  f.reset(); f.client.ctx.fileInfo = 'required';
  const prepared = await list(f.client, 'liked');
  expect(prepared.nextCursor).toBeUndefined(); expect(prepared.items).toHaveLength(24);
  expect(prepared.items.every(item => item.kind === 'file' && item.info && item.deferredInfo === undefined)).toBe(true);
  expect(prepared.items.map(item => item.kind === 'file' && item.fileRef)).toEqual(lazy.items.map(item => item.kind === 'file' && item.fileRef));
  expect(f.calls).toEqual({ user: 1, playlist: 2, lyrics: 24, cover: 1, range: 24 });
  f.reset(); delete f.client.ctx.fileInfo;
  const warm = await list(f.client, 'liked');
  expect(warm.items).toEqual(prepared.items); expect(f.calls).toEqual({ user: 1, playlist: 2 });
});

test('lazy GET retains the HEAD plan when expiring metadata changes the ready pointer and rejects another source plan', async () => {
  const f = fixture(2, 2); const page = await list(f.client, 'liked'); const entry = page.items[0]!; const second = page.items[1]!;
  if (entry.kind !== 'file' || second.kind !== 'file') throw new Error('Expected files');
  const before = await stat(f.client, entry.fileRef);
  const original = await open(f.client, entry.fileRef, { expectedContentId: before.contentId });
  const bytes = new Uint8Array(await new Response(original.body).arrayBuffer());
  const other = await stat(f.client, second.fileRef);
  await expect(open(f.client, entry.fileRef, { expectedContentId: other.contentId })).rejects.toMatchObject({ fault: { kind: 'content_changed' } });
  for (const [key, value] of f.cache.values) if (key.startsWith('ready:') || key === 'lyrics:1') value.expiresAt = 0;
  const next = { ...f.client, async call(endpoint: unknown, params: Record<string, Json> = {}) {
    return endpoint === endpoints.lyric ? { lrc: { lyric: '[00:00.00]Updated lyrics' } } : f.client.call(endpoint as never, params);
  } } as unknown as NeteaseClient;
  const after = await stat(next, entry.fileRef);
  expect(after.contentId).not.toBe(before.contentId);
  const old = await open(next, entry.fileRef, { expectedContentId: before.contentId });
  expect(old.content).toEqual(before);
  expect(new Uint8Array(await new Response(old.body).arrayBuffer())).toEqual(bytes);
  const fresh = await list(next, 'liked');
  expect(fresh.items[0]).toMatchObject({ fileRef: entry.fileRef, info: after });
});

test('opening a changed representation evicts only its short-lived version cache', async () => {
  const f = fixture(1, 1); f.client.ctx.fileInfo = 'required'; const page = await list(f.client, 'liked'); const entry = page.items[0]!;
  if (entry.kind !== 'file') throw new Error('Expected a prepared file');
  f.reset(); f.changeMedia();
  await expect(open(f.client, entry.fileRef, { expectedContentId: entry.info!.contentId })).rejects.toMatchObject({ fault: { kind: 'content_changed' } });
  expect([...f.cache.values.keys()].filter(key => key.startsWith('versions:'))).toHaveLength(1);
  f.reset(); const changed = await list(f.client, 'liked');
  expect(f.calls.playback).toBe(1);
  expect(changed.items[0]).not.toMatchObject({ info: { contentId: entry.info!.contentId } });
});

test('removing the last liked song publishes an empty directory without media requests', async () => {
  const f = fixture(1, 1); await list(f.client, 'liked');
  f.reset(); f.setPlaylist([]); const page = await list(f.client, 'liked');
  expect(page.items).toEqual([]); expect(page.nextCursor).toBeUndefined();
  expect(page.progress).toEqual({ completed: 0, total: 0, unit: '曲目' });
  expect(f.calls).toEqual({ user: 1, playlist: 2 });
});
