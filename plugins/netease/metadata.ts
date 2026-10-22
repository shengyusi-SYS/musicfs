import type { Json } from '@musicfs/plugin-api';
import type { AudioTags } from '@musicfs/audio-tags';
import { endpoints } from './generated-upstream.mjs';
import { fail, rateLimited, NeteaseFailure, object, type NeteaseClient } from './client';
import { metadataCacheExpiry } from './configuration';

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;
const positive = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
const names = (value: unknown) => Array.isArray(value) ? value.map(item => text(object(item).name)).filter((item): item is string => item !== undefined) : [];
const date = (value: unknown) => typeof value === 'number' && value > 0 && Number.isFinite(value) ? new Date(value + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : undefined;
const encode = (value: Uint8Array) => { let result = ''; for (let offset = 0; offset < value.length; offset += 16_384) result += String.fromCharCode(...value.subarray(offset, offset + 16_384)); return btoa(result); };
const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));

type Asset = { value: Json; expiresAt: number | null };
const earliestExpiry = (...values: (number | null | undefined)[]): number | null => {
  const finite = values.filter((value): value is number => typeof value === 'number');
  return finite.length ? Math.min(...finite) : null;
};
const pending = new WeakMap<NeteaseClient, Map<string, Promise<Asset>>>();
async function cached(client: NeteaseClient, key: string, read: () => Promise<Json>): Promise<Asset> {
  const cache = client.ctx.cache;
  if (!cache) fail('not_supported', '网易云补标签需要支持插件资料缓存的宿主。');
  let reads = pending.get(client); if (!reads) { reads = new Map(); pending.set(client, reads); }
  let result = reads.get(key);
  if (result) {
    const saved = await result;
    if (saved.expiresAt === null || saved.expiresAt > Date.now()) return saved;
    reads.delete(key); result = undefined;
  }
  if (!result) {
    result = (async () => {
      const previous = await cache.get(key);
      if (previous !== undefined) return previous as unknown as Asset;
      const value = await read(); client.ctx.signal.throwIfAborted();
      const missing = value === null || typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
      const asset = { value, expiresAt: metadataCacheExpiry(client.ctx.config, Date.now(), missing ? 30 : undefined) };
      await cache.put(key, asset, asset.expiresAt === null ? undefined : { expiresAt: asset.expiresAt }); return asset;
    })();
    reads.set(key, result);
  }
  try { return await result; } catch (error) { if (reads.get(key) === result) reads.delete(key); throw error; }
}

const coverHosts = new Set(['p1.music.126.net', 'p2.music.126.net', 'p3.music.126.net', 'p4.music.126.net']);
function coverKey(url: URL): string {
  // These image hosts are shards of the same resource; album IDs do not identify artwork bytes.
  return coverHosts.has(url.host) ? `cover:netease:${url.pathname}${url.search}` : `cover:url:${url.href}`;
}

async function cover(client: NeteaseClient, url: string): Promise<{ picture: AudioTags['cover']; expiresAt: number | null }> {
  const sized = new URL(url); sized.searchParams.set('param', '500y500');
  const asset = await cached(client, coverKey(sized), async () => {
    const response = await client.ctx.fetch(sized, { signal: client.ctx.signal });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (response.status === 429) { await response.body?.cancel(); rateLimited(response); }
    if (!response.ok) { await response.body?.cancel(); fail('temporary', '网易云专辑封面暂时无法读取。'); }
    const declaredType = response.headers.get('content-type')?.split(';')[0]?.trim();
    const mimeType = declaredType === 'image/jpg' ? 'image/jpeg' : declaredType;
    if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') { await response.body?.cancel(); fail('not_supported', '网易云封面不是支持的 JPEG 或 PNG。'); }
    return { mimeType, base64: encode(new Uint8Array(await response.arrayBuffer())) };
  });
  if (asset.value === null) return { picture: undefined, expiresAt: asset.expiresAt };
  const saved = object(asset.value);
  return { picture: { mimeType: String(saved.mimeType), data: decode(String(saved.base64)) }, expiresAt: asset.expiresAt };
}

/** Source album positions describe the recording; catalogue occurrence indices never enter tags. */
export async function musicTags(client: NeteaseClient, song: Record<string, unknown>, concurrency: 1 | 2 = 1): Promise<{ tags: AudioTags; expiresAt: number | null }> {
  const songId = String(song.id); const originalAlbum = object(song.al ?? song.album);
  const albumId = positive(originalAlbum.id);
  const albumAsset = albumId === undefined ? { value: originalAlbum as Json, expiresAt: metadataCacheExpiry(client.ctx.config) } : await cached(client, `album:${albumId}`, async () => {
    if (names(originalAlbum.artists ?? (originalAlbum.artist ? [originalAlbum.artist] : undefined)).length && (date(originalAlbum.publishTime) ?? date(song.publishTime))) return originalAlbum as Json;
    try { const result = await client.call(endpoints.album, { id: albumId }); const received = object(result.album);
      return Object.keys(received).length ? { ...originalAlbum, ...received } as Json : null; }
    catch (error) { if (error instanceof NeteaseFailure && error.fault.kind === 'not_found') return null; throw error; }
  });
  const album = { ...originalAlbum, ...object(albumAsset.value) };
  const readLyrics = () => cached(client, `lyrics:${songId}`, async () => {
    let result: Record<string, unknown>;
    try { result = await client.call(endpoints.lyric, { id: songId }); }
    catch (error) { if (error instanceof NeteaseFailure && error.fault.kind === 'not_found') return {}; throw error; }
    const original = text(object(result.lrc).lyric); const translation = text(object(result.tlyric).lyric); const romanization = text(object(result.romalrc).lyric);
    return { ...(original ? { original } : {}), ...(translation ? { translation } : {}), ...(romanization ? { romanization } : {}) };
  });
  const coverUrl = text(originalAlbum.picUrl) ?? text(album.picUrl);
  const readPicture = () => coverUrl ? cover(client, coverUrl) : Promise.resolve(undefined);
  let lyricAsset: Asset; let picture: Awaited<ReturnType<typeof cover>> | undefined;
  if (concurrency === 1) { lyricAsset = await readLyrics(); picture = await readPicture(); }
  else {
    // The caller reserves two slots only for a single-file operation, never on top of a file batch.
    // Drain both assets before returning, including failures, so no work outlives this invocation.
    const [lyrics, image] = await Promise.allSettled([readLyrics(), readPicture()]);
    if (image.status === 'rejected' && image.reason instanceof NeteaseFailure && image.reason.fault.kind === 'rate_limited') throw image.reason;
    if (lyrics.status === 'rejected') throw lyrics.reason;
    if (image.status === 'rejected') throw image.reason;
    lyricAsset = lyrics.value; picture = image.value;
  }
  const lyric = object(lyricAsset.value);
  const title = text(song.name); const artists = names(song.ar ?? song.artists); const albumName = text(originalAlbum.name) ?? text(album.name);
  const albumArtists = names(album.artists ?? (album.artist ? [album.artist] : undefined));
  const released = date(album.publishTime) ?? date(song.publishTime);
  const track = positive(song.no); const total = positive(album.size); const disc = positive(song.cd);
  return { expiresAt: earliestExpiry(albumAsset.expiresAt, lyricAsset.expiresAt, picture?.expiresAt),
    tags: { ...(title ? { title } : {}), ...(artists.length ? { artists } : {}), ...(albumName ? { album: albumName } : {}),
    ...(albumArtists.length ? { albumArtists } : {}), ...(released ? { date: released } : {}),
    ...(track ? { track: { number: track, ...(total ? { total } : {}) } } : {}), ...(disc ? { disc: { number: disc } } : {}),
    ...(picture?.picture ? { cover: picture.picture } : {}), ...(Object.keys(lyric).length ? { lyrics: lyric as NonNullable<AudioTags['lyrics']> } : {}) } };
}
