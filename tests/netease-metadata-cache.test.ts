import { expect, test } from 'bun:test';
import type { Context } from '@musicfs/plugin-api';
import { NeteaseClient } from '../plugins/netease/client';
import { endpoints } from '../plugins/netease/generated-upstream.mjs';
import { musicTags } from '../plugins/netease/metadata';
import { cover } from '../packages/audio-tags/test-fixtures';
import { memoryCache } from './helpers/source-metadata';

function fixture() {
  const requests: string[] = [];
  const ctx: Context = { instanceId: 'offline-cover-cache', config: {}, privateState: null,
    signal: new AbortController().signal, cache: memoryCache(),
    fetch: (async input => {
      requests.push(String(input));
      return new Response(cover, { headers: { 'Content-Type': 'image/png' } });
    }) as typeof fetch };
  const client = () => {
    const result = new NeteaseClient(ctx);
    result.call = async endpoint => { expect(endpoint).toBe(endpoints.lyric); return {}; };
    return result;
  };
  const song = (id: number, albumId: number, picUrl: string) => ({ id, name: `Song ${id}`, ar: [{ name: 'Artist' }],
    al: { id: albumId, name: `Album ${albumId}`, artists: [{ name: 'Album artist' }], publishTime: 1577836800000, picUrl } });
  return { client, requests, song };
}

test('NetEase shares artwork across album references and known CDN shards without rewriting the requested URL', async () => {
  const f = fixture();
  const first = await musicTags(f.client(), f.song(1, 10, 'https://p3.music.126.net/artwork/cover.png'));
  // A separate invocation must reuse the persisted resource, not only an in-flight Promise.
  const second = await musicTags(f.client(), f.song(2, 20, 'https://p4.music.126.net/artwork/cover.png'));
  expect(f.requests).toEqual(['https://p3.music.126.net/artwork/cover.png?param=500y500']);
  expect(first.tags.cover?.data).toEqual(cover); expect(second.tags.cover?.data).toEqual(cover);
  expect(first.tags.album).toBe('Album 10'); expect(second.tags.album).toBe('Album 20');
});

test('NetEase artwork cache keeps distinct resource paths, query variants and unknown origins separate', async () => {
  const f = fixture(); const client = f.client();
  const urls = ['https://p3.music.126.net/artwork/first.png', 'https://p4.music.126.net/artwork/second.png',
    'https://p3.music.126.net/artwork/first.png?version=2', 'https://images-a.example/cover.png', 'https://images-b.example/cover.png'];
  for (const [index, url] of urls.entries()) await musicTags(client, f.song(index + 1, 10, url));
  expect(f.requests).toEqual(urls.map(value => { const url = new URL(value); url.searchParams.set('param', '500y500'); return url.href; }));
});
