import type { Context, Json } from '@musicfs/plugin-api';
import { fixture, cover } from '../../packages/audio-tags/test-fixtures';

export const mediaBytes = {
  mp3: new Uint8Array(await Bun.file(new URL('../fixtures/source-metadata/source.mp3', import.meta.url)).arrayBuffer()),
  flac: new Uint8Array(await Bun.file(new URL('../fixtures/source-metadata/source.flac', import.meta.url)).arrayBuffer()),
  m4a: new Uint8Array(await Bun.file(new URL('../fixtures/source-metadata/source.m4a', import.meta.url)).arrayBuffer()),
  ape: fixture('ape').bytes,
};
export function mediaFor(url: string) {
  const extension = new URL(url).pathname.split('.').at(-1)?.toLowerCase();
  return mediaBytes[extension as keyof typeof mediaBytes] ?? mediaBytes.mp3;
}
export function memoryCache() {
  const values = new Map<string, { value: Json; expiresAt?: number }>();
  const cache: NonNullable<Context['cache']> = {
    async get(key) { const saved = values.get(key); return saved && (saved.expiresAt === undefined || saved.expiresAt > Date.now()) ? structuredClone(saved.value) : undefined; },
    async getMany(keys) { return Promise.all(keys.map(key => cache.get(key))); },
    async put(key, value, options) { values.set(key, { value: structuredClone(value), ...(options?.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }) }); },
    async putMany(items) { for (const item of items) await cache.put(item.key, item.value, item.expiresAt === undefined ? undefined : { expiresAt: item.expiresAt }); },
  };
  return { ...cache, values };
}
export const qqTrackFields = { album: { mid: 'albumFixture', name: '专辑' }, index_album: 7, index_cd: 2 };
/** Common optional source responses, still using each test's actual playback and account adapter. */
export function metadataFetch(fetcher: typeof fetch): typeof fetch {
  return (async (input, init) => {
    const req = new Request(input, init); const url = new URL(req.url);
    if (url.hostname === 'c.y.qq.com' && url.pathname.includes('/lyric/')) return Response.json({ code: 0, lyric: '[00:00.00]Original', trans: '[00:00.00]Translation', roma: '[00:00.00]Romanization' });
    if (url.hostname === 'c.y.qq.com' && url.pathname.includes('/fcg_v8_album_info')) return Response.json({ code: 0, data: { name: '专辑', aDate: '2020-02-03', singer: [{ name: '专辑歌手' }], total: 12 } });
    if (url.hostname === 'y.gtimg.cn') return new Response(cover, { headers: { 'Content-Type': 'image/png' } });
    if (/\/(eapi|weapi)\/song\/lyric\/v1$/.test(url.pathname)) return Response.json({ code: 200, lrc: { lyric: '[00:00.00]原文' }, tlyric: { lyric: '[00:00.00]译文' }, romalrc: { lyric: '[00:00.00]Romanization' } });
    return fetcher(input, init);
  }) as typeof fetch;
}
