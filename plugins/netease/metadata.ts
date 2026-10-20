import type { Json } from '@musicfs/plugin-api';
import type { AudioTags } from '@musicfs/audio-tags';
import { endpoints } from './generated-upstream.mjs';
import { fail, NeteaseFailure, object, type NeteaseClient } from './client';

const lifetime = 24 * 60 * 60 * 1000;
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;
const positive = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
const names = (value: unknown) => Array.isArray(value) ? value.map(item => text(object(item).name)).filter((item): item is string => item !== undefined) : [];
const date = (value: unknown) => typeof value === 'number' && value > 0 && Number.isFinite(value) ? new Date(value + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : undefined;
const encode = (value: Uint8Array) => { let result = ''; for (let offset = 0; offset < value.length; offset += 16_384) result += String.fromCharCode(...value.subarray(offset, offset + 16_384)); return btoa(result); };
const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));

async function cached(client: NeteaseClient, key: string, read: () => Promise<Json>): Promise<Json> {
  const cache = client.ctx.cache;
  if (!cache) fail('not_supported', '网易云补标签需要支持插件资料缓存的宿主。');
  const previous = await cache.get(key);
  if (previous !== undefined) return previous;
  const value = await read(); client.ctx.signal.throwIfAborted();
  await cache.put(key, value, { expiresAt: Date.now() + lifetime });
  return value;
}

async function cover(client: NeteaseClient, albumId: string, url: string): Promise<AudioTags['cover']> {
  const sized = new URL(url); sized.searchParams.set('param', '500y500');
  const value = await cached(client, `cover:${albumId}:${sized.href}`, async () => {
    const response = await client.ctx.fetch(sized, { signal: client.ctx.signal });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (response.status === 429) { await response.body?.cancel(); fail('rate_limited', '网易云封面读取过于频繁，请稍后重试。'); }
    if (!response.ok) { await response.body?.cancel(); fail('temporary', '网易云专辑封面暂时无法读取。'); }
    const declaredType = response.headers.get('content-type')?.split(';')[0]?.trim();
    const mimeType = declaredType === 'image/jpg' ? 'image/jpeg' : declaredType;
    if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') { await response.body?.cancel(); fail('not_supported', '网易云封面不是支持的 JPEG 或 PNG。'); }
    return { mimeType, base64: encode(new Uint8Array(await response.arrayBuffer())) };
  });
  if (value === null) return;
  const saved = object(value);
  return { mimeType: String(saved.mimeType), data: decode(String(saved.base64)) };
}

/** Source album positions describe the recording; catalogue occurrence indices never enter tags. */
export async function musicTags(client: NeteaseClient, song: Record<string, unknown>): Promise<AudioTags> {
  const songId = String(song.id); const originalAlbum = object(song.al ?? song.album);
  const albumId = positive(originalAlbum.id);
  const album = albumId === undefined ? originalAlbum : object(await cached(client, `album:${albumId}`, async () => {
    if (names(originalAlbum.artists ?? (originalAlbum.artist ? [originalAlbum.artist] : undefined)).length && (date(originalAlbum.publishTime) ?? date(song.publishTime))) return originalAlbum as Json;
    try { const result = await client.call(endpoints.album, { id: albumId }); return { ...originalAlbum, ...object(result.album) } as Json; }
    catch (error) { if (error instanceof NeteaseFailure && error.fault.kind === 'not_found') return originalAlbum as Json; throw error; }
  }));
  const lyric = object(await cached(client, `lyrics:${songId}`, async () => {
    let result: Record<string, unknown>;
    try { result = await client.call(endpoints.lyric, { id: songId }); }
    catch (error) { if (error instanceof NeteaseFailure && error.fault.kind === 'not_found') return {}; throw error; }
    const original = text(object(result.lrc).lyric); const translation = text(object(result.tlyric).lyric); const romanization = text(object(result.romalrc).lyric);
    return { ...(original ? { original } : {}), ...(translation ? { translation } : {}), ...(romanization ? { romanization } : {}) };
  }));
  const title = text(song.name); const artists = names(song.ar ?? song.artists); const albumName = text(originalAlbum.name) ?? text(album.name);
  const albumArtists = names(album.artists ?? (album.artist ? [album.artist] : undefined));
  const released = date(album.publishTime) ?? date(song.publishTime);
  const track = positive(song.no); const total = positive(album.size); const disc = positive(song.cd);
  const coverUrl = text(originalAlbum.picUrl) ?? text(album.picUrl);
  const picture = coverUrl ? await cover(client, String(albumId ?? songId), coverUrl) : undefined;
  return { ...(title ? { title } : {}), ...(artists.length ? { artists } : {}), ...(albumName ? { album: albumName } : {}),
    ...(albumArtists.length ? { albumArtists } : {}), ...(released ? { date: released } : {}),
    ...(track ? { track: { number: track, ...(total ? { total } : {}) } } : {}), ...(disc ? { disc: { number: disc } } : {}),
    ...(picture ? { cover: picture } : {}), ...(Object.keys(lyric).length ? { lyrics: lyric as NonNullable<AudioTags['lyrics']> } : {}) };
}
