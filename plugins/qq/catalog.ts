import type { Entry, Json, Page, Root } from '@musicfs/plugin-api';
import { z } from 'zod';
import { fail, object, QqFailure, type QqClient } from './client';
import { DAILY_SONGS } from './generated-upstream.mjs';
import { audioPolicy } from './configuration';
import { readCollection, type CollectionKind } from './collections';
import { parsePlaylistRef, playlistRef, positiveId, type PlaylistReference } from './playlist-reference';
import { preparation, preparePage } from './preparation';

const song = z.object({ mid: z.string().regex(/^[A-Za-z0-9]+$/), title: z.string(),
  singer: z.array(z.object({ name: z.string() }).passthrough()), file: z.object({ media_mid: z.string().regex(/^[A-Za-z0-9]+$/) }).passthrough() }).passthrough();
const pageCursor = z.object({ directory: z.string(), offset: z.number().int().nonnegative().max(100_000), total: z.number().int().nonnegative(),
  instanceId: z.string().optional(), revision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
type Cursor = z.infer<typeof pageCursor>;

function cursorOf(client: QqClient, directory: string, cursor?: string): Cursor | undefined {
  if (cursor === undefined) return;
  try {
    const position = pageCursor.parse(JSON.parse(cursor));
    if (position.directory === directory && (position.instanceId === undefined || position.instanceId === client.ctx.instanceId)
      && (directory !== 'daily' || position.instanceId !== undefined && position.revision !== undefined)) return position;
  }
  catch { /* All invalid or cross-directory cursors share the same public fault. */ }
  return fail('not_found', 'QQ 分页位置无效。');
}

export async function roots(client: QqClient, cursor?: string): Promise<Page<Root>> {
  client.requireSession(); if (cursor !== undefined) fail('not_found', 'QQ 内容源分页位置无效。');
  // Verify the restored credential through an authenticated read, not just its local presence.
  const status = await client.call('/login/status');
  if (!Object.keys(object(object(status.data).profile)).length) return client.needsAuthentication();
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
  try { result = await client.recommendations(); }
  catch (error) { if (error instanceof QqFailure && error.fault.kind === 'not_found') return { items: [] }; throw error; }
  const data = z.array(z.object({ tid: positiveId, title: z.string().min(1) })).safeParse(result.playlists);
  if (!data.success) fail('temporary', 'QQ 返回了无法识别的推荐歌单。');
  return { items: data.data.map(item => ({ kind: 'directory', entryId: item.tid, name: item.title,
    directoryRef: playlistRef({ kind: 'playlist', role: 'recommended', tid: item.tid }) })) };
}

async function playlistSongs(client: QqClient, playlist: PlaylistReference | null, offset: number, count: number): Promise<Record<string, unknown>> {
  const raw = await client.rpc(session => {
    if (playlist === null || playlist.role === 'created') {
      if (playlist && !playlist.dirId) fail('not_found', 'QQ 自建歌单引用缺少目录身份。');
      if (typeof session.credential.encryptUin !== 'string' || !session.credential.encryptUin) fail('needs_auth', 'QQ 会话缺少读取歌单所需的账号信息，请重新扫码。');
      return { module: 'music.srfDissInfo.DissInfo', method: 'CgiGetDiss', operation: 'session.authenticated-read', readOnly: true,
        param: { disstid: playlist ? Number(playlist.tid) : 0, dirid: playlist ? playlist.dirId : 201, tag: true, song_begin: offset, song_num: count,
          userinfo: true, orderlist: true, enc_host_uin: session.credential.encryptUin } };
    }
    return { module: 'music.srfDissInfo.aiDissInfo', method: 'uniform_get_Dissinfo', operation: 'playlist.authenticated-detail', readOnly: true,
      param: { disstid: Number(playlist.tid), userinfo: 1, tag: 1, orderlist: 1, song_begin: offset, song_num: count, onlysonglist: 0, enc_host_uin: '' } };
  });
  const total = raw.total_song_num; const songs = raw.songlist;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || !Array.isArray(songs)) fail('temporary', 'QQ 歌单曲目总数或列表无效。');
  // This native endpoint sometimes reports hasmore after its explicit total was read.
  return { songs, total, more: offset + songs.length < total };
}

export async function list(client: QqClient, directory: string, cursor?: string): Promise<Page<Entry>> {
  client.requireSession();
  const position = cursorOf(client, directory, cursor);
  if (directory === 'created' || directory === 'favorites') return collections(client, directory, position);
  if (directory === 'recommended') return recommendations(client, cursor);
  const playlist = directory === 'liked' || directory === 'daily' ? null : parsePlaylistRef(directory);
  const offset = position?.offset ?? 0;
  const policy = client.ctx.cache?.getMany ? preparation : { ...preparation, warmFiles: 4, concurrency: 1 };
  const count = Math.max(1, Math.floor(policy.warmFiles / audioPolicy(client.ctx.config).qualities.length));
  const previousDaily = directory === 'daily' && position?.revision ? await client.ctx.cache?.get(`daily:${position.revision}`) : undefined;
  if (directory === 'daily' && position && previousDaily === undefined) fail('content_changed', 'QQ 每日推荐分页资料已失效，请重新刷新。');
  const result = directory === 'daily' ? previousDaily === undefined ? await client.rpc(() => DAILY_SONGS) : { songs: previousDaily }
    : await playlistSongs(client, playlist, offset, count);
  const parsed = z.array(song).safeParse(result.songs);
  if (!parsed.success) fail('temporary', 'QQ 歌曲资料格式暂时无法识别。');
  const received = parsed.data;
  const total = directory === 'daily' ? received.length : result.total;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) fail('temporary', 'QQ 返回了不一致的歌曲总数。');
  if (position && position.total !== total) fail('content_changed', 'QQ 集合在分页期间发生变化，请重新刷新。');
  let revision: string | undefined;
  if (directory === 'daily') {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(received)));
    revision = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (position && position.revision !== revision) fail('content_changed', 'QQ 每日推荐在分页期间发生变化，请重新刷新。');
    if (!client.ctx.cache) fail('not_supported', 'QQ 补标签需要支持插件资料缓存的宿主。');
    if (!position) await client.ctx.cache.put(`daily:${revision}`, received as Json, { expiresAt: Date.now() + 30 * 60_000 });
  }
  if (offset > total || directory !== 'daily' && (offset + received.length > total || typeof result.more !== 'boolean')) fail('temporary', 'QQ 返回了不一致的歌曲分页。');
  const songs = (directory === 'daily' ? received.slice(offset) : received).slice(0, count);
  if (offset < total && !songs.length) fail('temporary', 'QQ 分页提前结束，尚未取得完整集合。');
  const content = await preparePage(client, songs, offset, policy);
  return { ...content.page, progress: { completed: offset + content.consumed, total, unit: '曲目' },
    ...(offset + content.consumed < total ? { nextCursor: JSON.stringify({ directory, instanceId: client.ctx.instanceId, offset: offset + content.consumed, total, ...(revision ? { revision } : {}) }) } : {}) };
}
