import { expect, test } from 'bun:test';
import type { Context } from '@musicfs/plugin-api';
import { endpoints, type UpstreamRequest } from '../plugins/netease/generated-upstream.mjs';
import { NeteaseClient } from '../plugins/netease/client';
import { compactSong, playlistScan, scanSongs } from '../plugins/netease/scan';
import { memoryCache } from './helpers/source-metadata';

test('NetEase rich song details use one SDK weapi request for the complete ID batch', async () => {
  const calls: unknown[] = [];
  const request: UpstreamRequest = async (uri, data, options) => {
    calls.push({ uri, data, crypto: options.crypto });
    return { status: 200, body: { code: 200, songs: [] }, cookie: [] };
  };
  await endpoints.songs({ ids: '101,102,103' }, request);
  expect(calls).toEqual([{ uri: '/api/song/detail/', data: { ids: '["101","102","103"]' }, crypto: 'weapi' }]);
});

test('NetEase rich detail SDK path retains client encryption, cancellation and rate-limit handling', async () => {
  const controller = new AbortController(); let calls = 0;
  const ctx: Context = { instanceId: 'offline-rich-details', config: {}, privateState: null, signal: controller.signal,
    fetch: (async (input, init) => {
      calls++;
      expect(String(input)).toBe('https://music.163.com/weapi/song/detail/');
      expect(init?.signal).toBe(controller.signal);
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('params')).toBeTruthy(); expect(body.get('encSecKey')).toBeTruthy();
      expect(body.has('ids')).toBe(false);
      return new Response(null, { status: 429, headers: { 'Retry-After': '4' } });
    }) as typeof fetch };
  const client = new NeteaseClient(ctx);
  await expect(client.call(endpoints.songs, { ids: '101,102' })).rejects.toMatchObject({ fault: { kind: 'rate_limited', retryAfterSeconds: 4 } });
  controller.abort();
  await expect(client.call(endpoints.songs, { ids: '101,102' })).rejects.toBe(controller.signal.reason);
  expect(calls).toBe(1);
});

test('NetEase normalizes rich legacy album and disc fields for metadata preparation', () => {
  const compact = compactSong({ id: 1, name: 'Song', artists: [{ id: 2, name: 'Singer' }], disc: '2', no: 7,
    album: { id: 3, name: 'Album', picUrl: 'https://p1.music.126.net/cover.jpg', artists: [{ id: 4, name: 'Album artist', alias: ['unused'] }],
      artist: { id: 4, name: 'Album artist', picUrl: 'unused' }, publishTime: 1577836800000, size: 9 } });
  expect(compact).toMatchObject({ id: 1, ar: [{ name: 'Singer' }], cd: '2', no: 7, al: { artists: [{ name: 'Album artist' }], publishTime: 1577836800000 } });
  expect(compact?.al).toEqual({ id: 3, name: 'Album', picUrl: 'https://p1.music.126.net/cover.jpg', artists: [{ name: 'Album artist' }],
    artist: { name: 'Album artist' }, publishTime: 1577836800000, size: 9 });
});

test('NetEase keeps current playlist names and artwork when freshly enriching a sparse seed', async () => {
  const cache = memoryCache();
  const client = { ctx: { cache }, async call(endpoint: unknown) {
    if (endpoint === endpoints.playlist) return { playlist: { trackIds: [{ id: 1 }], trackCount: 1, tracks: [
      { id: 1, name: 'Current title', ar: [{ name: 'Current singer' }], al: { id: 3, name: 'Current album', picUrl: 'current.jpg' } }
    ] } };
    expect(endpoint).toBe(endpoints.songs);
    return { songs: [{ id: 1, name: 'Old title', artists: [{ name: 'Old singer' }], disc: '2',
      album: { id: 3, name: 'Old album', picUrl: 'old.jpg', artists: [{ name: 'Album singer' }], publishTime: 1577836800000 } }] };
  } } as unknown as NeteaseClient;
  const result = await scanSongs(client, await playlistScan(client, '10'), 0);
  expect(result.songs[0]).toMatchObject({ name: 'Current title', ar: [{ name: 'Current singer' }], cd: '2', richDetail: true,
    al: { name: 'Current album', picUrl: 'current.jpg', artists: [{ name: 'Album singer' }], publishTime: 1577836800000 } });
});

test('NetEase enriches incomplete playlist seeds in a true batch and caches absent rich fields', async () => {
  const cache = memoryCache(); const batches: string[][] = [];
  const seed = (id: number) => ({ id, name: `Song ${id}`, ar: [{ name: 'Singer' }], al: { id: 3, name: 'Album' } });
  const client = { ctx: { cache }, async call(endpoint: unknown, params: Record<string, unknown>) {
    if (endpoint === endpoints.playlist) return { playlist: { trackIds: [{ id: 1 }, { id: 2 }], trackCount: 2, tracks: [seed(1), seed(2)] } };
    expect(endpoint).toBe(endpoints.songs);
    const ids = String(params.ids).split(','); batches.push(ids);
    // Missing album artists/date are an upstream absence, not an invitation to request them every scan.
    return { songs: ids.map(id => ({ id: Number(id), name: `Song ${id}`, artists: [{ name: 'Singer' }], disc: '1', album: { id: 3, name: 'Album' } })) };
  } } as unknown as NeteaseClient;
  const first = await scanSongs(client, await playlistScan(client, '10'), 0);
  expect(batches).toEqual([['1', '2']]);
  expect(first.songs).toHaveLength(2); expect(first.songs[0]).toMatchObject({ richDetail: true, cd: '1' });
  await scanSongs(client, await playlistScan(client, '10'), 0);
  expect(batches).toHaveLength(1);
  for (const [key, value] of cache.values) if (key.startsWith('song:')) value.expiresAt = 0;
  await scanSongs(client, await playlistScan(client, '10'), 0);
  expect(batches).toEqual([['1', '2'], ['1', '2']]);
});
