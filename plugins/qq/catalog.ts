import type { Entry, Page, Root } from '@musicfs/plugin-api';
import { z } from 'zod';
import { fail, object, QqFailure, type QqClient } from './client';
import { formats, resolveVariants, trackKey } from './playback';
import { MUSIC_FILE_TYPES } from './generated-upstream.mjs';
import { readCollection, type CollectionKind } from './collections';
import { parsePlaylistRef, playlistRef, positiveId, type PlaylistReference } from './playlist-reference';

const song = z.object({ mid: z.string().regex(/^[A-Za-z0-9]+$/), title: z.string(),
  singer: z.array(z.object({ name: z.string() })), file: z.object({ media_mid: z.string().regex(/^[A-Za-z0-9]+$/) }).passthrough() });
const pageCursor = z.object({ directory: z.string(), offset: z.number().int().nonnegative().max(100_000), total: z.number().int().nonnegative() }).strict();
type Cursor = z.infer<typeof pageCursor>;

function cursorOf(directory: string, cursor?: string): Cursor | undefined {
  if (cursor === undefined) return;
  try { const position = pageCursor.parse(JSON.parse(cursor)); if (position.directory === directory) return position; }
  catch { /* All invalid or cross-directory cursors share the same public fault. */ }
  return fail('not_found', 'QQ 分页位置无效。');
}

export async function roots(client: QqClient, cursor?: string): Promise<Page<Root>> {
  client.requireSession(); if (cursor !== undefined) fail('not_found', 'QQ 内容源分页位置无效。');
  // Verify the restored credential through an authenticated read, not just its local presence.
  const status = await client.call('/login/status');
  if (!Object.keys(object(object(status.data).profile)).length) fail('needs_auth', 'QQ 授权已失效，请重新扫码。');
  const label = typeof object(client.ctx.config).label === 'string' ? object(client.ctx.config).label : 'QQ 音乐';
  return { items: [
    { sourceId: 'liked', name: `${label} · 喜欢的音乐`, directoryRef: 'liked' },
    { sourceId: 'daily', name: `${label} · 每日推荐`, directoryRef: 'daily' },
    { sourceId: 'created', name: `${label} · 自建歌单`, directoryRef: 'created' },
    { sourceId: 'favorites', name: `${label} · 收藏歌单`, directoryRef: 'favorites' },
    { sourceId: 'recommended', name: `${label} · 推荐歌单`, directoryRef: 'recommended' }
  ] };
}

async function collections(client: QqClient, kind: CollectionKind, position?: Cursor): Promise<Page<Entry>> {
  if (kind === 'created' && position) fail('not_found', '自建歌单接口返回完整集合，没有续读分页。');
  const offset = position?.offset ?? 0; const page = await readCollection(client, kind, offset);
  if (position && position.total !== page.total) fail('content_changed', 'QQ 收藏集合在分页期间发生变化，请重新刷新。');
  const items: Entry[] = page.items.flatMap(raw => {
    const value = object(raw);
    let dirId: number | undefined;
    if (kind === 'created') {
      if (typeof value.dirId !== 'number' || !Number.isSafeInteger(value.dirId) || value.dirId < 1) fail('temporary', 'QQ 自建目录身份无效。');
      // Native system-directory IDs, including liked(201), are separate content sources.
      if (value.dirId >= 200) return [];
      if (value.dirType !== undefined && value.dirType !== 0) fail('not_supported', 'QQ 返回了尚未支持的自建目录类型。');
      dirId = value.dirId;
    }
    const tid = positiveId.safeParse(kind === 'created' ? value.tid : value.id ?? value.tid);
    const name = kind === 'created' ? value.dirName : value.title;
    if (!tid.success || typeof name !== 'string' || !name.trim()) fail('temporary', 'QQ 返回了无法识别的歌单条目。');
    return [{ kind: 'directory' as const, entryId: tid.data, name,
      directoryRef: playlistRef({ kind: 'playlist', role: kind, tid: tid.data, ...(dirId ? { dirId } : {}) }) }];
  });
  return { items, ...(page.more ? { nextCursor: JSON.stringify({ directory: kind, offset: offset + page.items.length, total: page.total }) } : {}) };
}

async function recommendations(client: QqClient, cursor?: string): Promise<Page<Entry>> {
  if (cursor !== undefined) fail('not_found', '推荐歌单是有限快照，没有续读分页。');
  let result: Record<string, unknown>;
  try { result = await client.call('/recommend/playlists', { limit: '25' }); }
  catch (error) { if (error instanceof QqFailure && error.fault.kind === 'not_found') return { items: [] }; throw error; }
  const data = z.array(z.object({ tid: positiveId, title: z.string().min(1) })).safeParse(result.playlists);
  if (!data.success) fail('temporary', 'QQ 返回了无法识别的推荐歌单。');
  return { items: data.data.map(item => ({ kind: 'directory', entryId: item.tid, name: item.title,
    directoryRef: playlistRef({ kind: 'playlist', role: 'recommended', tid: item.tid }) })) };
}

async function playlistSongs(client: QqClient, playlist: PlaylistReference, offset: number): Promise<Record<string, unknown>> {
  const raw = await client.rpc(session => {
    if (playlist.role === 'created') {
      if (!playlist.dirId || typeof session.credential.encryptUin !== 'string') fail('not_found', 'QQ 自建歌单引用缺少目录身份。');
      return { module: 'music.srfDissInfo.DissInfo', method: 'CgiGetDiss', operation: 'session.authenticated-read', readOnly: true,
        param: { disstid: Number(playlist.tid), dirid: playlist.dirId, tag: true, song_begin: offset, song_num: 100,
          userinfo: true, orderlist: true, enc_host_uin: session.credential.encryptUin } };
    }
    return { module: 'music.srfDissInfo.aiDissInfo', method: 'uniform_get_Dissinfo', operation: 'playlist.authenticated-detail', readOnly: true,
      param: { disstid: Number(playlist.tid), userinfo: 1, tag: 1, orderlist: 1, song_begin: offset, song_num: 100, onlysonglist: 0, enc_host_uin: '' } };
  });
  const total = raw.total_song_num; const songs = raw.songlist;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || !Array.isArray(songs)) fail('temporary', 'QQ 歌单曲目总数或列表无效。');
  // This native endpoint sometimes reports hasmore after its explicit total was read.
  return { songs, total, more: offset + songs.length < total };
}

export async function list(client: QqClient, directory: string, cursor?: string): Promise<Page<Entry>> {
  client.requireSession();
  const position = cursorOf(directory, cursor);
  if (directory === 'created' || directory === 'favorites') return collections(client, directory, position);
  if (directory === 'recommended') return recommendations(client, cursor);
  const playlist = directory === 'liked' || directory === 'daily' ? null : parsePlaylistRef(directory);
  if (directory === 'daily' && position) fail('not_found', '每日推荐是有限集合，没有续读分页。');
  const offset = position?.offset ?? 0;
  let result: Record<string, unknown>;
  try { result = playlist ? await playlistSongs(client, playlist, offset)
    : await client.call(directory === 'liked' ? '/user/liked-songs' : '/user/daily-songs', { offset: String(offset), limit: '100' }); }
  catch (error) {
    if (directory === 'daily' && error instanceof QqFailure && error.fault.kind === 'not_found') return { items: [], statistics: { tracks: 0, files: 0 } };
    throw error;
  }
  const parsed = z.array(song).safeParse(result.songs);
  if (!parsed.success) fail('temporary', 'QQ 歌曲资料格式暂时无法识别。');
  const songs = parsed.data;
  const total = directory === 'daily' ? songs.length : result.total;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) fail('temporary', 'QQ 返回了不一致的歌曲总数。');
  if (position && position.total !== total) fail('content_changed', 'QQ 集合在分页期间发生变化，请重新刷新。');
  if (offset + songs.length > total || directory !== 'daily' && typeof result.more !== 'boolean') fail('temporary', 'QQ 返回了不一致的歌曲分页。');
  const more = directory !== 'daily' && (result.more === true || offset + songs.length < total);
  if (more && !songs.length) fail('temporary', 'QQ 分页提前结束，尚未取得完整集合。');
  const resolved = await resolveVariants(client, songs);
  const statistics = { tracks: songs.length, files: 0, hiddenTracks: 0, missingVersions: 0, fallbackVersions: 0, deduplicatedVersions: 0 };
  const items: Entry[] = songs.flatMap((item, index) => {
    const resolution = resolved.get(trackKey(item))!;
    if (!resolution.variants.length) statistics.hiddenTracks++;
    statistics.missingVersions += resolution.missingVersions; statistics.fallbackVersions += resolution.fallbackVersions;
    statistics.deduplicatedVersions += resolution.deduplicatedVersions;
    const occurrence = offset + index;
    return resolution.variants.map(variant => ({ kind: 'file' as const, entryId: `${occurrence}:${item.mid}:${variant.quality}`,
      name: `${String(occurrence + 1).padStart(4, '0')} - ${item.title} - ${item.singer.map(artist => artist.name).join('、')} [${formats[variant.quality].label}]${MUSIC_FILE_TYPES[variant.quality].extension}`, fileRef: variant.fileRef }));
  });
  statistics.files = items.length;
  return { items, statistics,
    ...(more ? { nextCursor: JSON.stringify({ directory, offset: offset + songs.length, total }) } : {}) };
}
