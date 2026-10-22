import type { Json } from '@musicfs/plugin-api';
import { endpoints } from './generated-upstream.mjs';
import { fail, object, type NeteaseClient } from './client';
import { resolveVariants, resolutionKey, type Resolution, type CachedResolution } from './media';
import { metadataCacheExpiry } from './configuration';

export const batchSize = 200;
const lifetime = 24 * 60 * 60_000;
export type SongScan = { id: string; playlistId: string; ids: string[]; revision: string; startedAt: string };
export const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
export function trackId(value: unknown): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('temporary', '网易云返回了无法精确识别的内容编号。');
  const result = String(value ?? ''); if (!/^[1-9]\d*$/.test(result)) fail('temporary', '网易云返回了无效内容编号。'); return result;
}
const pick = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
export function compactSong(input: unknown): Record<string, unknown> | undefined {
  const song = object(input); const artists = song.ar ?? song.artists;
  if (typeof song.name !== 'string' || !song.name || !Array.isArray(artists) || !artists.every(item => typeof object(item).name === 'string' && object(item).name)) return;
  const album = object(song.al ?? song.album);
  return { ...pick(song, ['id', 'name', 'no', 'publishTime']), ...((song.cd ?? song.disc) === undefined ? {} : { cd: song.cd ?? song.disc }),
    ...(song.richDetail === true ? { richDetail: true } : {}), ar: artists.map(item => pick(object(item), ['name'])),
    al: { ...pick(album, ['id', 'name', 'picUrl', 'publishTime', 'size']),
      ...(Array.isArray(album.artists) ? { artists: album.artists.map(item => pick(object(item), ['name'])) } : {}),
      ...(album.artist === undefined ? {} : { artist: pick(object(album.artist), ['name']) }) } };
}
function needsDetail(song: Record<string, unknown> | undefined) {
  if (!song) return true;
  if (song.richDetail === true) return false;
  const album = object(song.al); const artists = album.artists ?? (album.artist ? [album.artist] : []);
  const hasArtists = Array.isArray(artists) && artists.some(item => typeof object(item).name === 'string' && String(object(item).name).trim());
  const hasDate = [album.publishTime, song.publishTime].some(value => typeof value === 'number' && Number.isFinite(value) && value > 0);
  return !hasArtists || !hasDate;
}
function mergeSeed(saved: Record<string, unknown>, seed: Record<string, unknown> | undefined) {
  if (!seed) return saved;
  const cachedAlbum = object(saved.al); const album = object(seed.al);
  // A current playlist owns names/cover references. Reuse rich album fields only
  // for the same album, rather than replacing them with a sparse playlist seed.
  if (album.id !== cachedAlbum.id) return seed;
  return { ...saved, ...seed, al: { ...cachedAlbum, ...album }, ...(saved.richDetail === true ? { richDetail: true } : {}) };
}
async function membership(client: NeteaseClient, playlistId: string) {
  const result = object((await client.call(endpoints.playlist, { id: playlistId })).playlist);
  if (!Array.isArray(result.trackIds) || !Number.isSafeInteger(result.trackCount) || result.trackCount !== result.trackIds.length) fail('temporary', '网易云歌单曲目列表未完整返回。');
  const ids = result.trackIds.map(item => trackId(object(item).id));
  return { ids, revision: await hash(ids), tracks: Array.isArray(result.tracks) ? result.tracks : [] };
}
export async function playlistScan(client: NeteaseClient, playlistId: string, scanId?: string, revision?: string): Promise<SongScan> {
  const cache = client.ctx.cache;
  if (!cache) fail('not_supported', '网易云补标签需要支持插件资料缓存的宿主。');
  if (scanId) {
    const saved = await cache.get(`scan:${scanId}`) as unknown as SongScan | undefined;
    if (!saved || saved.playlistId !== playlistId || saved.revision !== revision) fail('content_changed', '网易云本次歌单准备资料已失效，请重新刷新。');
    return saved;
  }
  const result = await membership(client, playlistId);
  if (revision && revision !== result.revision) fail('content_changed', '网易云歌单在分页期间已变化，请重新刷新。');
  const scan = { id: crypto.randomUUID(), playlistId, ids: result.ids, revision: result.revision, startedAt: new Date().toISOString() };
  // Keep the ordered IDs separate from bounded song-detail blocks.
  const seeds = new Map(result.tracks.flatMap(item => { const song = compactSong(item); return song ? [[trackId(song.id), song] as const] : []; }));
  const blocks: { key: string; value: Json; expiresAt: number }[] = [];
  for (let start = 0; start < scan.ids.length; start += batchSize) {
    const songs = [...new Set(scan.ids.slice(start, start + batchSize))].flatMap(id => seeds.has(id) ? [seeds.get(id)!] : []);
    if (songs.length) blocks.push({ key: `scan:${scan.id}:songs:${start}`, value: songs as Json, expiresAt: Date.now() + lifetime });
  }
  blocks.push({ key: `scan:${scan.id}`, value: scan as unknown as Json, expiresAt: Date.now() + lifetime });
  if (cache.putMany) await cache.putMany(blocks);
  else for (const item of blocks) await cache.put(item.key, item.value, { expiresAt: item.expiresAt });
  return scan;
}
export async function verifyScan(client: NeteaseClient, scan: SongScan) {
  if ((await membership(client, scan.playlistId)).revision !== scan.revision) fail('content_changed', '网易云歌单在准备期间已变化，请重新刷新。');
}
export async function scanSongs(client: NeteaseClient, scan: SongScan, offset: number) {
  const start = Math.floor(offset / batchSize) * batchSize; const ids = scan.ids.slice(start, start + batchSize);
  const key = `scan:${scan.id}:songs:${start}`;
  const cached = await client.ctx.cache!.get(key);
  const seeds = Array.isArray(cached) ? cached : object(cached).songs;
  const byId = new Map((Array.isArray(seeds) ? seeds : []).map(item => { const song = object(item); return [trackId(song.id), song]; }));
  if (object(cached).complete === true) return { start, songs: ids.map(id => byId.get(id)!) };
  // Membership is always fresh. Stable song facts can be shared across scans and playlists.
  const fresh = new Map([...byId].filter(([, song]) => !needsDetail(song)));
  const incomplete = [...new Set(ids)].filter(id => needsDetail(byId.get(id)));
  const cache = client.ctx.cache!;
  if (cache.getMany && incomplete.length) {
    const saved = await cache.getMany(incomplete.map(id => `song:${id}`));
    saved.forEach((song, index) => { if (song) { const id = incomplete[index]!; byId.set(id, mergeSeed(object(song), byId.get(id))); } });
  }
  const missing = [...new Set(ids)].filter(id => needsDetail(byId.get(id)));
  if (missing.length) {
    const details = await client.call(endpoints.songs, { ids: missing.join(',') });
    if (!Array.isArray(details.songs)) fail('temporary', '网易云未返回完整歌曲详情。');
    for (const item of details.songs) { const song = compactSong(item); if (song) {
      const id = trackId(song.id); const rich = mergeSeed(song, byId.get(id)); rich.richDetail = true;
      byId.set(id, rich); fresh.set(id, rich);
    } }
    for (const id of missing) if (byId.get(id)?.richDetail !== true) fail('temporary', '网易云歌曲详情分页不完整。');
  }
  const expiresAt = Date.now() + lifetime;
  const detailExpiresAt = metadataCacheExpiry(client.ctx.config);
  const writes: { key: string; value: Json; expiresAt?: number }[] = [{ key, value: { complete: true, songs: [...new Set(ids)].map(id => byId.get(id)!) } as Json, expiresAt },
    ...(cache.getMany ? [...fresh].map(([id, song]) => ({ key: `song:${id}`, value: song as Json, ...(detailExpiresAt === null ? {} : { expiresAt: detailExpiresAt }) })) : [])];
  if (cache.putMany) await cache.putMany(writes);
  else for (const item of writes) await cache.put(item.key, item.value, item.expiresAt === undefined ? undefined : { expiresAt: item.expiresAt });
  return { start, songs: ids.map(id => byId.get(id)!) };
}
export async function scanVersions(client: NeteaseClient, scan: SongScan, start: number, ids: string[]) {
  if (!ids.length) return new Map<string, Resolution>();
  const key = `scan:${scan.id}:versions:${start}`;
  const saved = await client.ctx.cache!.get(key);
  if (Array.isArray(saved)) return new Map(saved as unknown as [string, Resolution][]);
  const cache = client.ctx.cache!; const unique = [...new Set(ids)];
  const reused = cache.getMany ? await cache.getMany(unique.map(id => resolutionKey(client, id))) : [];
  const versions = new Map<string, Resolution>(); const expiries: number[] = [];
  reused.forEach((item, index) => { if (item) { const record = item as unknown as CachedResolution; versions.set(unique[index]!, record.value); expiries.push(record.expiresAt); } });
  const missing = unique.filter(id => !versions.has(id));
  const writes: { key: string; value: Json; expiresAt: number }[] = [];
  if (missing.length) for (const [id, value] of await resolveVariants(client, missing)) {
    versions.set(id, value);
    // A missing target is rechecked sooner; successful locators never outlive native expiry.
    const expiresAt = Math.min(Date.now() + (value.missingVersions ? 30_000 : 5 * 60_000),
      ...value.variants.map(variant => variant.location.expiresAt ?? 0));
    expiries.push(expiresAt);
    if (cache.getMany && expiresAt > Date.now()) writes.push({ key: resolutionKey(client, id), value: { value, expiresAt } as unknown as Json, expiresAt });
  }
  const expiry = Math.min(...expiries);
  if (expiry > Date.now()) writes.push({ key, value: [...versions] as unknown as Json, expiresAt: expiry });
  if (cache.putMany && writes.length) await cache.putMany(writes);
  else for (const item of writes) await cache.put(item.key, item.value, { expiresAt: item.expiresAt });
  return versions;
}
