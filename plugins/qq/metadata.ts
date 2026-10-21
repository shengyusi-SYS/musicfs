import type { Json } from '@musicfs/plugin-api';
import type { AudioTags } from '@musicfs/audio-tags';
import { fail, object, QqFailure, type QqClient } from './client';
import { metadataCacheExpiry } from './configuration';

const missingLifetime = 24 * 60 * 60 * 1000;
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;
const positive = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
const names = (value: unknown) => Array.isArray(value) ? value.map(item => text(object(item).name ?? object(item).singername)).filter((item): item is string => item !== undefined) : [];
const encode = (value: Uint8Array) => { let result = ''; for (let offset = 0; offset < value.length; offset += 16_384) result += String.fromCharCode(...value.subarray(offset, offset + 16_384)); return btoa(result); };
const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));
const encodedLyric = (value: unknown) => {
  if (typeof value !== 'string' || !value) return;
  try { return text(new TextDecoder('utf-8', { fatal: true }).decode(decode(value))); }
  catch { return; }
};

type Asset = { value: Json; expiresAt: number | null };
const earliestExpiry = (...values: (number | null | undefined)[]): number | null => {
  const finite = values.filter((value): value is number => typeof value === 'number');
  return finite.length ? Math.min(...finite) : null;
};
const pending = new WeakMap<QqClient, Map<string, Promise<Asset>>>();
async function cached(client: QqClient, key: string, read: () => Promise<Json>): Promise<Asset> {
  const cache = client.ctx.cache;
  if (!cache) fail('not_supported', 'QQ 补标签需要支持插件资料缓存的宿主。');
  let reads = pending.get(client); if (!reads) { reads = new Map(); pending.set(client, reads); }
  const earlier = reads.get(key);
  if (earlier) { const saved = await earlier; if (saved.expiresAt === null || saved.expiresAt > Date.now()) return saved; reads.delete(key); }
  // This envelope owns its original expiry; a cache hit never renews dependent ready indexes.
  const storageKey = `metadata:${key}`;
  const result = (async () => {
    const previous = await cache.get(storageKey);
    if (previous !== undefined) return previous as unknown as Asset;
    const value = await read(); client.ctx.signal.throwIfAborted();
    const missing = value === null || typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
    const asset = { value, expiresAt: missing ? Date.now() + missingLifetime : metadataCacheExpiry(client.ctx.config) };
    await cache.put(storageKey, asset, asset.expiresAt === null ? undefined : { expiresAt: asset.expiresAt }); return asset;
  })();
  reads.set(key, result);
  try { return await result; } catch (error) { if (reads.get(key) === result) reads.delete(key); throw error; }
}

/** These SDK legacy reads otherwise require a global transport; keep the same endpoints request-scoped. */
async function legacy(client: QqClient, path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = new URL(path, 'https://c.y.qq.com');
  for (const [key, value] of Object.entries({ format: 'json', outCharset: 'utf-8', ...params })) url.searchParams.set(key, value);
  const response = await client.ctx.fetch(url, { signal: client.ctx.signal, headers: { Referer: 'https://y.qq.com/' } });
  if (response.status === 404) { await response.body?.cancel(); return {}; }
  if (response.status === 429) { await response.body?.cancel(); fail('rate_limited', 'QQ 音乐资料读取过于频繁，请稍后重试。'); }
  if (!response.ok) { await response.body?.cancel(); fail('temporary', 'QQ 音乐资料暂时无法读取。'); }
  const result = object(await response.json());
  if (result.code !== undefined && result.code !== 0) fail('temporary', 'QQ 音乐资料暂时无法返回。');
  return result;
}

async function cover(client: QqClient, albumId: string, url: string): Promise<{ picture: AudioTags['cover']; expiresAt: number | null }> {
  const asset = await cached(client, `cover:${albumId}:${url}`, async () => {
    const response = await client.ctx.fetch(url, { signal: client.ctx.signal });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (response.status === 429) { await response.body?.cancel(); fail('rate_limited', 'QQ 封面读取过于频繁，请稍后重试。'); }
    if (!response.ok) { await response.body?.cancel(); fail('temporary', 'QQ 专辑封面暂时无法读取。'); }
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim();
    if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') { await response.body?.cancel(); fail('not_supported', 'QQ 封面不是支持的 JPEG 或 PNG。'); }
    return { mimeType, base64: encode(new Uint8Array(await response.arrayBuffer())) };
  });
  if (asset.value === null) return { picture: undefined, expiresAt: asset.expiresAt };
  const saved = object(asset.value); return { picture: { mimeType: String(saved.mimeType), data: decode(String(saved.base64)) }, expiresAt: asset.expiresAt };
}

export async function musicTags(client: QqClient, source: Record<string, unknown>): Promise<{ tags: AudioTags; expiresAt: number | null }> {
  const mid = String(source.mid);
  const sourceAlbum = object(source.album);
  const complete = source.index_album !== undefined && source.index_cd !== undefined && sourceAlbum.mid && sourceAlbum.name;
  const detailAsset = complete ? { value: source as Json, expiresAt: metadataCacheExpiry(client.ctx.config) } : await cached(client, `song:${mid}`, async () => {
    try {
      const result = await client.rpc(() => ({ module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq', param: { song_type: 0, song_mid: mid }, readOnly: true, operation: 'session.authenticated-read' }));
      const received = object(result.track_info);
      return Object.keys(received).length ? { ...source, ...received } as Json : null;
    } catch (error) { if (error instanceof QqFailure && error.fault.kind === 'not_found') return null; throw error; }
  });
  // The fresh catalogue's fields win over an older auxiliary detail response.
  const detail: Record<string, unknown> = { ...object(detailAsset.value), ...source,
    album: { ...object(object(detailAsset.value).album), ...object(source.album) } };
  const originalAlbum = object(detail.album); const albumMid = text(originalAlbum.mid);
  const albumAsset = albumMid ? await cached(client, `album:${albumMid}`, async () => {
    if (names(originalAlbum.singer ?? originalAlbum.singers).length && text(originalAlbum.aDate ?? originalAlbum.time_public)) return originalAlbum as Json;
    const result = await legacy(client, '/v8/fcg-bin/fcg_v8_album_info_cp.fcg', { albummid: albumMid }); return object(result.data) as Json;
  }) : { value: originalAlbum as Json, expiresAt: detailAsset.expiresAt };
  const album = object(albumAsset.value);
  const lyricAsset = await cached(client, `lyrics:${mid}`, async () => {
    const result = await legacy(client, '/lyric/fcgi-bin/fcg_query_lyric_new.fcg', { songmid: mid, nobase64: '1' });
    const original = text(result.lyric); let translation = text(result.trans); const romanization = text(result.roma);
    if (!translation || !romanization) {
      const extra = await client.rpc(() => ({ module: 'music.musichallSong.PlayLyricInfo', method: 'GetPlayLyricInfo', readOnly: true, operation: 'lyric.translation',
        param: { songMID: mid, songName: '', singerName: '', albumName: '', interval: 0, crypt: 0, ct: 19, cv: 2111, lrc_t: 0, qrc: 0, qrc_t: 0, roma: 1, roma_t: 0, trans: 1, trans_t: 0, type: 0 } }));
      translation ??= encodedLyric(extra.trans);
      const actualRomanization = romanization ?? encodedLyric(extra.roma);
      return { ...(original ? { original } : {}), ...(translation ? { translation } : {}), ...(actualRomanization ? { romanization: actualRomanization } : {}) };
    }
    return { ...(original ? { original } : {}), ...(translation ? { translation } : {}), ...(romanization ? { romanization } : {}) };
  });
  const lyrics = object(lyricAsset.value);
  const title = text(detail.title ?? detail.name); const artists = names(detail.singer); const albumName = text(originalAlbum.name) ?? text(album.name);
  const albumArtists = names(album.singer ?? album.singers ?? (text(album.singername) ? [{ name: album.singername }] : undefined)); const released = text(album.aDate ?? album.date ?? originalAlbum.time_public ?? detail.time_public);
  const track = positive(detail.index_album); const disc = positive(detail.index_cd); const total = positive(album.total);
  const coverUrl = text(originalAlbum.picUrl) ?? text(album.picUrl) ?? (albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg?max_age=2592000` : undefined);
  const picture = coverUrl ? await cover(client, albumMid ?? mid, coverUrl) : undefined;
  return { expiresAt: earliestExpiry(detailAsset.expiresAt, albumAsset.expiresAt, lyricAsset.expiresAt, picture?.expiresAt),
    tags: { ...(title ? { title } : {}), ...(artists.length ? { artists } : {}), ...(albumName ? { album: albumName } : {}),
    ...(albumArtists.length ? { albumArtists } : {}), ...(released ? { date: released } : {}), ...(track ? { track: { number: track, ...(total ? { total } : {}) } } : {}),
    ...(disc ? { disc: { number: disc } } : {}), ...(picture?.picture ? { cover: picture.picture } : {}), ...(Object.keys(lyrics).length ? { lyrics: lyrics as NonNullable<AudioTags['lyrics']> } : {}) } };
}
