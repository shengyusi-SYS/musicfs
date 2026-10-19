import { z } from 'zod';
import { fail, type QqClient } from './client';
import { credentialMusicId } from './generated-upstream.mjs';

export type CollectionKind = 'created' | 'favorites';
export type CollectionPage = { items: unknown[]; more: boolean; total: number };

/** Read the original collections before the SDK's HTTP facade merges their roles. */
export async function readCollection(client: QqClient, kind: CollectionKind, offset: number): Promise<CollectionPage> {
  const body = await client.rpc(session => {
    const uin = kind === 'created' ? credentialMusicId(session.credential) : session.credential.encryptUin;
    if (typeof uin !== 'string' || !uin) fail('needs_auth', 'QQ 会话缺少读取歌单所需的账号信息，请重新扫码。');
    return { module: kind === 'created' ? 'music.musicasset.PlaylistBaseRead' : 'music.musicasset.PlaylistFavRead',
      method: kind === 'created' ? 'GetPlaylistByUin' : 'CgiGetPlaylistFavInfo',
      param: kind === 'created' ? { uin } : { uin, offset, size: 100 }, readOnly: true, operation: 'session.authenticated-read' };
  });
  const list = z.array(z.unknown()).safeParse(body[kind === 'created' ? 'v_playlist' : 'v_list']);
  const total = body.total;
  if (!list.success || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) fail('temporary', 'QQ 返回了无法确认完整性的歌单集合。');
  if (kind === 'created') {
    if (body.bFinish !== undefined && typeof body.bFinish !== 'boolean') fail('temporary', 'QQ 自建集合完成标记无效。');
    // This SDK endpoint returns the entire collection, including system folders.
    if (body.bFinish === false || list.data.length !== total) fail('not_supported', 'QQ 自建歌单响应不完整，当前接口未提供可靠的续读位置。');
    return { items: list.data, total, more: false };
  }
  if (body.hasmore !== undefined && ![true, false, 0, 1].includes(body.hasmore as boolean | number)) fail('temporary', 'QQ 收藏分页标记无效。');
  const more = body.hasmore === true || body.hasmore === 1 || offset + list.data.length < total;
  if (offset + list.data.length > total || more && !list.data.length) fail('temporary', 'QQ 收藏分页不完整。');
  return { items: list.data, total, more };
}
