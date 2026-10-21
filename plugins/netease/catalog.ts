import type { Entry, Json, Page, Root } from '@musicfs/plugin-api';
import pLimit from 'p-limit';
import { z } from 'zod';
import { endpoints } from './generated-upstream.mjs';
import { fail, object, type NeteaseClient } from './client';
import { info, sourceReader, resolveVariants, type Resolution } from './media';
import { audioPolicy, labels } from './configuration';
import { songKey, descriptorKey, deferredFileRef, prepareSongFile, type PreparedFile } from './tagged';
import { batchSize, compactSong, playlistScan, scanSongs, scanVersions, verifyScan } from './scan';

const rootsList = [ ['liked', '喜欢的歌曲'], ['daily', '每日推荐歌曲'], ['created', '自建歌单'], ['favorites', '收藏歌单'], ['recommended', '每日推荐歌单'] ] as const;
const playlistRef = z.object({ kind: z.literal('playlist'), id: z.string().regex(/^[1-9]\d*$/) }).strict();
const cursorSchema = z.object({ directory: z.string(), offset: z.number().int().nonnegative().safe(), revision: z.string().optional(),
  scanId: z.string().optional(), likedPlaylistId: z.string().regex(/^[1-9]\d*$/).optional(), instanceId: z.string().min(1).optional() }).strict()
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
export type PreparationPolicy = { warmFiles: number; concurrency: number; coldFiles?: number; milliseconds?: number };
const preparation: PreparationPolicy = { warmFiles: 100, concurrency: 2, coldFiles: 32, milliseconds: 2000 };
async function songPage(client: NeteaseClient, tracks: unknown[], offset: number, policy: PreparationPolicy,
  versions?: Map<string, Resolution>): Promise<{ page: Page<Entry>; consumed: number }> {
  const started = performance.now();
  const songs = tracks.map(item => compactSong(item) ?? object(item)); const ids = songs.map(song => id(song.id));
  const statistics = emptyStatistics();
  if (!ids.length) return { page: { items: [], statistics }, consumed: 0 };
  const resolved = versions ?? await resolveVariants(client, ids);
  const candidates = await Promise.all(songs.map(async (song, index) => {
    const resolution = resolved.get(ids[index]!)!;
    const files = await Promise.all(resolution.variants.map(async variant => ({ variant,
      key: await songKey(variant.reference, info(variant.reference), song) })));
    return { song, songId: ids[index]!, position: offset + index + 1, resolution, files };
  }));
  const keys = candidates.flatMap(item => item.files.map(file => file.key));
  const saved = client.ctx.cache!.getMany ? await client.ctx.cache!.getMany(keys) : await Promise.all(keys.map(key => client.ctx.cache!.get(key)));
  const ready = new Map(keys.map((key, index) => [key, saved[index] as unknown as PreparedFile | undefined]));
  const saveSeeds = async (items: typeof candidates) => {
    // File references outlive scan/song caches, so retain only published compact seeds without an expiry.
    const seeds = new Map(items.flatMap(item => item.files.map(file => [descriptorKey(file.key), item.song as Json] as const)));
    const writes = [...seeds].map(([key, value]) => ({ key, value }));
    if (client.ctx.cache!.putMany) await client.ctx.cache!.putMany(writes);
    else for (const item of writes) await client.ctx.cache!.put(item.key, item.value);
  };
  const entry = (item: typeof candidates[number], candidate: typeof item.files[number], file?: PreparedFile): Entry => {
    const media = candidate.variant.reference;
    const artists = item.song.ar ?? item.song.artists;
    if (!Array.isArray(artists)) fail('temporary', '网易云未返回完整歌曲名称信息。');
    const artist = artists.map(value => label(object(value).name)).join('、');
    return { kind: 'file', entryId: `${item.position}:${item.songId}:${media.level}`,
      name: `${String(item.position).padStart(4, '0')}. ${label(item.song.name)} - ${artist} [${labels[media.level]}].${media.type}`,
      fileRef: deferredFileRef(media, candidate.key), ...(file ? { info: file.info } : { deferredInfo: true }) };
  };
  const count = (item: typeof candidates[number]) => {
    statistics.tracks++;
    statistics.missingVersions += item.resolution.missingVersions; statistics.fallbackVersions += item.resolution.fallbackVersions;
    statistics.deduplicatedVersions += item.resolution.deduplicatedVersions;
    if (!item.files.length) statistics.hiddenTracks++;
  };
  if (client.ctx.fileInfo !== 'required') {
    const items = candidates.flatMap(item => {
      count(item);
      return item.files.map(candidate => entry(item, candidate, ready.get(candidate.key)));
    });
    await saveSeeds(candidates);
    statistics.files = items.length;
    return { page: { items, statistics }, consumed: candidates.length };
  }
  const items: Entry[] = []; let consumed = 0; let cold = 0; let failure: unknown;
  let largestCost = 0;
  const limit = pLimit(policy.concurrency);
  const prepared = new Map<string, Promise<PreparedFile>>();
  // Process only a bounded chunk at a time; never queue a whole account.
  for (let start = 0; start < candidates.length;) {
    const remaining = client.ctx.workBudget?.remaining ?? Infinity;
    const nextCold = candidates[start]!.files.some(file => !ready.has(file.key) || !ready.get(file.key));
    if (consumed && nextCold && remaining < (largestCost ? largestCost + 2 : 24)) break;
    const width = client.ctx.workBudget ? 1 : policy.concurrency;
    const before = remaining;
    const chunk = candidates.slice(start, start + width);
    const work = chunk.map(item => limit(async () => {
      if (failure) throw failure;
      client.ctx.signal.throwIfAborted();
      try {
        const files = [];
        for (const candidate of item.files) {
          const media = candidate.variant.reference;
          let file = ready.get(candidate.key);
          if (!file) {
            let pending = prepared.get(candidate.key);
            if (!pending) {
              pending = prepareSongFile(client, candidate.key, media, info(media), item.song,
                sourceReader(client, media, candidate.variant.location));
              prepared.set(candidate.key, pending); cold++;
            }
            file = await pending;
          }
          files.push(entry(item, candidate, file));
        }
        return files;
      } catch (error) { failure ??= error; throw error; }
    }));
    const outcome = await Promise.allSettled(work);
    if (failure) throw failure;
    largestCost = Math.max(largestCost, before === Infinity ? 0 : before - (client.ctx.workBudget?.remaining ?? before));
    for (let i = 0; i < chunk.length; i++) {
      const result = outcome[i]!; if (result.status === 'rejected') throw result.reason;
      const item = chunk[i]!; items.push(...result.value); consumed++; count(item);
    }
    start += chunk.length;
    if (cold >= (policy.coldFiles ?? 32) || cold > 0 && performance.now() - started >= (policy.milliseconds ?? 2000)) break;
  }
  await saveSeeds(candidates.slice(0, consumed));
  statistics.files = items.length;
  return { page: { items, statistics }, consumed };
}
export async function list(client: NeteaseClient, directory: string, value?: string, requestedPolicy: PreparationPolicy = preparation): Promise<Page<Entry>> {
  const policy = client.ctx.cache?.getMany ? requestedPolicy : { warmFiles: 8, concurrency: 1, coldFiles: 8, milliseconds: 2000 };
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
    if (!client.ctx.cache) fail('not_supported', '网易云补标签需要支持插件资料缓存的宿主。');
    let tracks: unknown; let revision = page.revision;
    if (revision) tracks = await client.ctx.cache.get(`daily:${revision}`);
    else {
      tracks = object((await client.call(endpoints.daily)).data).dailySongs;
      if (!Array.isArray(tracks)) fail('temporary', '网易云未返回完整每日推荐歌曲。');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(tracks)));
      revision = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      await client.ctx.cache.put(`daily:${revision}`, tracks as Json, { expiresAt: Date.now() + 30 * 60_000 });
    }
    if (!Array.isArray(tracks)) fail('content_changed', '网易云每日推荐分页资料已失效，请重新刷新。');
    const count = client.ctx.fileInfo === 'required' ? Math.max(1, Math.floor(policy.warmFiles / audioPolicy(client.ctx.config).qualities.length)) : batchSize;
    const content = await songPage(client, tracks.slice(page.offset, page.offset + count), page.offset, policy);
    return { ...content.page, progress: { completed: page.offset + content.consumed, total: tracks.length, unit: '曲目' },
      ...(page.offset + content.consumed < tracks.length ? { nextCursor: JSON.stringify({ directory, offset: page.offset + content.consumed, revision }) } : {}) };
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
  const scan = await playlistScan(client, playlistId, page.scanId, page.revision);
  const batch = await scanSongs(client, scan, page.offset);
  const versions = await scanVersions(client, scan, batch.start, batch.songs.map(song => id(song.id)));
  const count = client.ctx.fileInfo === 'required' ? Math.max(1, Math.floor(policy.warmFiles / audioPolicy(client.ctx.config).qualities.length)) : batchSize;
  const content = await songPage(client, batch.songs.slice(page.offset - batch.start, page.offset - batch.start + count), page.offset, policy, versions);
  const next = page.offset + content.consumed;
  if (next >= scan.ids.length) await verifyScan(client, scan);
  return { ...content.page, progress: { completed: next, total: scan.ids.length, unit: '曲目' }, ...(next < scan.ids.length ? { nextCursor: JSON.stringify({ directory, offset: next, revision: scan.revision, scanId: scan.id,
    ...(directory === 'liked' ? { likedPlaylistId: playlistId, instanceId: client.ctx.instanceId } : {}) }) } : {}) };
}
