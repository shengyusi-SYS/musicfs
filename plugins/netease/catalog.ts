import type { Entry, Page, Root } from '@musicfs/plugin-api';
import { z } from 'zod';
import { endpoints } from './generated-upstream.mjs';
import { fail, object, type NeteaseClient } from './client';
import { info, resolveVariants } from './media';
import { labels } from './configuration';

const rootsList = [ ['liked', '喜欢的歌曲'], ['daily', '每日推荐歌曲'], ['created', '自建歌单'], ['favorites', '收藏歌单'], ['recommended', '每日推荐歌单'] ] as const;
const playlistRef = z.object({ kind: z.literal('playlist'), id: z.string().regex(/^[1-9]\d*$/) }).strict();
const cursorSchema = z.object({ directory: z.string(), offset: z.number().int().nonnegative().safe(), revision: z.string().optional(),
  likedPlaylistId: z.string().regex(/^[1-9]\d*$/).optional(), instanceId: z.string().min(1).optional() }).strict()
  .refine(value => (value.likedPlaylistId === undefined) === (value.instanceId === undefined));
const emptyStatistics = () => ({ tracks: 0, files: 0, hiddenTracks: 0, missingVersions: 0, fallbackVersions: 0, deduplicatedVersions: 0 });
function id(value: unknown): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('temporary', '网易云返回了无法精确识别的内容编号。');
  const result = String(value ?? ''); if (!/^[1-9]\d*$/.test(result)) fail('temporary', '网易云返回了无效内容编号。'); return result;
}
function label(value: unknown): string { if (typeof value !== 'string' || !value) fail('temporary', '网易云返回了无效内容名称。'); return value; }
function cursor(directory: string, value?: string) {
  if (value === undefined) return { directory, offset: 0 };
  let decoded: unknown; try { decoded = JSON.parse(value); } catch { fail('invalid_config', '网易云目录游标无法识别。'); }
  const result = cursorSchema.safeParse(decoded);
  if (!result.success || result.data.directory !== directory) fail('invalid_config', '网易云目录游标不匹配。');
  return result.data;
}
const directoryEntry = (value: unknown): Entry => {
  const item = object(value); const playlistId = id(item.id);
  return { kind: 'directory', entryId: playlistId, name: label(item.name), directoryRef: JSON.stringify({ kind: 'playlist', id: playlistId }) };
};
async function playlists(client: NeteaseClient, offset: number) {
  if (!client.state.accountId) await client.profile();
  const result = await client.call(endpoints.userPlaylists, { uid: client.state.accountId, limit: 100, offset });
  if (!Array.isArray(result.playlist) || typeof result.more !== 'boolean') fail('temporary', '网易云未返回完整歌单分页信息。');
  if (result.more && !result.playlist.length) fail('temporary', '网易云歌单分页提前结束。');
  return { items: result.playlist.map(object), more: result.more };
}
export async function roots(client: NeteaseClient, value?: string): Promise<Page<Root>> {
  client.requireSession(); if (value !== undefined) fail('invalid_config', '网易云入口没有下一页。');
  await client.profile();
  return { items: rootsList.map(([sourceId, name]) => ({ sourceId, name, directoryRef: sourceId })) };
}
async function songPage(client: NeteaseClient, tracks: unknown[], offset: number): Promise<Page<Entry>> {
  const songs = tracks.map(item => object(item)); const ids = songs.map(song => id(song.id));
  if (!ids.length) return { items: [], statistics: emptyStatistics() };
  const versions = await resolveVariants(client, ids); const statistics = emptyStatistics(); statistics.tracks = tracks.length;
  const items: Entry[] = [];
  for (let index = 0; index < songs.length; index++) {
    const song = songs[index]!; const songId = ids[index]!; const resolution = versions.get(songId)!;
    statistics.missingVersions += resolution.missingVersions; statistics.fallbackVersions += resolution.fallbackVersions; statistics.deduplicatedVersions += resolution.deduplicatedVersions;
    if (!resolution.variants.length) { statistics.hiddenTracks++; continue; }
    const artists = song.ar ?? song.artists;
    if (!Array.isArray(artists)) fail('temporary', '网易云未返回完整歌曲名称信息。');
    const artist = artists.map(item => label(object(item).name)).join('、');
    const position = offset + index + 1;
    for (const variant of resolution.variants) {
      const media = variant.reference;
      items.push({ kind: 'file', entryId: `${position}:${songId}:${media.level}`, name: `${String(position).padStart(4, '0')}. ${label(song.name)} - ${artist} [${labels[media.level]}].${media.type}`, fileRef: JSON.stringify(media), info: info(media) });
    }
  }
  statistics.files = items.length; return { items, statistics };
}
export async function list(client: NeteaseClient, directory: string, value?: string): Promise<Page<Entry>> {
  client.requireSession(); const page = cursor(directory, value);
  if (page.likedPlaylistId && (directory !== 'liked' || page.instanceId !== client.ctx.instanceId)) fail('invalid_config', '网易云喜欢目录游标不属于当前实例。');
  if (directory === 'created' || directory === 'favorites') {
    const result = await playlists(client, page.offset);
    const items = result.items.filter(item => item.specialType !== 5).filter(item => {
      const owner = id(item.userId ?? object(item.creator).userId);
      return (owner === client.state.accountId) === (directory === 'created');
    }).map(directoryEntry);
    return { items, ...(result.more ? { nextCursor: JSON.stringify({ directory, offset: page.offset + result.items.length }) } : {}) };
  }
  if (directory === 'recommended') {
    if (page.offset) fail('invalid_config', '每日推荐歌单是一次有限集合。');
    const result = await client.call(endpoints.recommended);
    if (!Array.isArray(result.recommend)) fail('temporary', '网易云未返回完整每日推荐歌单。');
    return { items: result.recommend.map(directoryEntry) };
  }
  if (directory === 'daily') {
    if (page.offset) fail('invalid_config', '每日推荐歌曲是一次有限集合。');
    const result = object((await client.call(endpoints.daily)).data);
    if (!Array.isArray(result.dailySongs)) fail('temporary', '网易云未返回完整每日推荐歌曲。');
    // Bound API batches without truncating the finite recommendation snapshot.
    const pages: Page<Entry>[] = [];
    for (let offset = 0; offset < result.dailySongs.length; offset += 100) pages.push(await songPage(client, result.dailySongs.slice(offset, offset + 100), offset));
    const statistics = emptyStatistics();
    for (const page of pages) for (const key of Object.keys(statistics) as (keyof typeof statistics)[]) statistics[key] += page.statistics?.[key] ?? 0;
    return { items: pages.flatMap(page => page.items), statistics };
  }
  let playlistId: string;
  if (directory === 'liked') {
    let found = page.likedPlaylistId;
    if (!found) {
      let offset = 0;
      for (;;) {
        const result = await playlists(client, offset);
        const liked = result.items.find(item => item.specialType === 5 && id(item.userId ?? object(item.creator).userId) === client.state.accountId);
        if (liked) { found = id(liked.id); break; }
        if (!result.more) break;
        offset += result.items.length;
        if (offset > 100_000) fail('not_supported', '网易云歌单集合超过当前处理上限。');
      }
    }
    if (!found) return { items: [], statistics: emptyStatistics() };
    playlistId = found;
  } else {
    let raw: unknown; try { raw = JSON.parse(directory); } catch { fail('not_found', '网易云目录不存在。'); }
    const parsed = playlistRef.safeParse(raw); if (!parsed.success) fail('not_found', '网易云目录不存在。'); playlistId = parsed.data.id;
  }
  const result = object((await client.call(endpoints.playlist, { id: playlistId })).playlist);
  if (!Array.isArray(result.trackIds) || !Number.isSafeInteger(result.trackCount) || result.trackCount !== result.trackIds.length) fail('temporary', '网易云歌单曲目列表未完整返回。');
  const ids = result.trackIds.map(item => id(object(item).id));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ids)));
  const revision = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (page.revision && page.revision !== revision) fail('content_changed', '网易云歌单在分页期间已变化，请重新刷新。');
  const selected = ids.slice(page.offset, page.offset + 100);
  if (!selected.length) return { items: [], statistics: emptyStatistics() };
  const details = await client.call(endpoints.songs, { ids: [...new Set(selected)].join(',') });
  if (!Array.isArray(details.songs)) fail('temporary', '网易云未返回完整歌曲详情。');
  const byId = new Map(details.songs.map(song => [id(object(song).id), song]));
  const ordered = selected.map(songId => { const item = byId.get(songId); if (!item) fail('temporary', '网易云歌曲详情分页不完整。'); return item; });
  const content = await songPage(client, ordered, page.offset);
  return { ...content, ...(page.offset + selected.length < ids.length ? { nextCursor: JSON.stringify({ directory, offset: page.offset + selected.length, revision,
    ...(directory === 'liked' ? { likedPlaylistId: playlistId, instanceId: client.ctx.instanceId } : {}) }) } : {}) };
}
