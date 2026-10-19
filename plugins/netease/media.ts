import type { FileInfo, ReadRequest, ReadResult } from '@musicfs/plugin-api';
import { z } from 'zod';
import { endpoints } from './generated-upstream.mjs';
import { fail, object, type NeteaseClient } from './client';
import { audioPolicy, lowerQualities, qualities, type Quality } from './configuration';

const reference = z.object({ version: z.literal(1), id: z.string().regex(/^[1-9]\d*$/), level: z.enum(qualities), type: z.enum(['mp3', 'flac', 'm4a']), md5: z.string().regex(/^[a-fA-F0-9]{32}$/), size: z.number().int().positive().safe() }).strict();
export type MediaReference = z.infer<typeof reference>;
const mime = { mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4' };
type Location = { reference: MediaReference; url: string };
type Variant = { reference: MediaReference; targets: Quality[] };
type Resolution = { variants: Variant[]; missingVersions: number; fallbackVersions: number; deduplicatedVersions: number };
export function decodeFile(file: string): MediaReference {
  let value: unknown; try { value = JSON.parse(file); } catch { fail('not_found', '无效的网易云文件引用。'); }
  const parsed = reference.safeParse(value); if (!parsed.success) fail('not_found', '无效的网易云文件引用。'); return parsed.data;
}
function mediaUrl(value: unknown): string {
  if (typeof value !== 'string') fail('temporary', '网易云未返回有效音频地址。');
  let url: URL; try { url = new URL(value); } catch { fail('temporary', '网易云音频地址无法识别。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['music.126.net', 'music.163.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) fail('not_supported', '网易云返回了不受支持的音频来源。');
  return url.href;
}
/** Resolve one native request level; other levels are eligible only under fallback. */
export async function resolveMedia(client: NeteaseClient, ids: string[], selected: Quality, fallback = false): Promise<Map<string, Location>> {
  client.requireSession();
  const response = await client.call(endpoints.playback, { id: ids.join(','), level: selected });
  if (!Array.isArray(response.data)) fail('temporary', '网易云未返回完整音频版本信息。');
  const result = new Map<string, Location>();
  const candidates = new Map<string, Map<Quality, Location>>();
  const eligible = [selected, ...(fallback ? lowerQualities(selected) : [])];
  const requested = new Set(ids);
  const seen = new Set<string>();
  for (const value of response.data) {
    const item = object(value); const id = String(item.id ?? '');
    if (!requested.has(id)) fail('temporary', '网易云返回了不一致的音频列表。'); seen.add(id);
    if (!item.url || item.freeTrialInfo !== null && item.freeTrialInfo !== undefined || !eligible.includes(item.level as Quality)) continue;
    const parsed = reference.safeParse({ version: 1, id, level: item.level, type: typeof item.type === 'string' ? item.type.toLowerCase() : item.type, md5: item.md5, size: item.size });
    if (!parsed.success) fail('temporary', '网易云音频的完整版本信息无法确认。');
    const perTrack = candidates.get(id) ?? new Map<Quality, Location>();
    const previous = perTrack.get(parsed.data.level);
    if (previous) {
      // One native response can contain several levels for the same track.
      // URLs are temporary locators; only the actual selected representation
      // determines whether two complete candidates describe the same file.
      if (info(previous.reference).contentId !== info(parsed.data).contentId) fail('temporary', '网易云返回了冲突的目标音质版本。');
      continue;
    }
    perTrack.set(parsed.data.level, { reference: parsed.data, url: mediaUrl(item.url) }); candidates.set(id, perTrack);
  }
  if (seen.size !== requested.size) fail('temporary', '网易云音频列表未完整返回。');
  for (const id of requested) {
    const available = candidates.get(id);
    const best = eligible.find(level => available?.has(level));
    if (best) result.set(id, available!.get(best)!);
  }
  return result;
}
export const info = (ref: MediaReference): FileInfo => ({ contentId: JSON.stringify([ref.id, ref.level, ref.type, ref.md5.toLowerCase(), ref.size]), size: ref.size, mediaType: mime[ref.type] });

/** Resolve unique songs once per requested level; catalogue occurrences stay separate. */
export async function resolveVariants(client: NeteaseClient, input: string[]): Promise<Map<string, Resolution>> {
  const policy = audioPolicy(client.ctx.config);
  const ids = [...new Set(input)]; const targets = qualities.filter(level => policy.qualities.includes(level));
  const resolved = new Map<string, Resolution>(ids.map(id => [id, { variants: [], missingVersions: 0, fallbackVersions: 0, deduplicatedVersions: 0 }]));
  const cache = new Map<Quality, Map<string, Location | null>>();
  for (const target of targets) {
    let pending = [...ids];
    for (const requested of [target, ...(policy.missingQuality === 'fallback' ? lowerQualities(target) : [])]) {
      if (!pending.length) break;
      const stored = cache.get(requested) ?? new Map<string, Location | null>(); cache.set(requested, stored);
      const missing = pending.filter(id => !stored.has(id));
      if (missing.length) {
        const locations = await resolveMedia(client, missing, requested, policy.missingQuality === 'fallback');
        for (const id of missing) stored.set(id, locations.get(id) ?? null);
      }
      pending = pending.filter(id => {
        const found = stored.get(id); if (!found) return true;
        const resolution = resolved.get(id)!;
        if (found.reference.level !== target) resolution.fallbackVersions++;
        const previous = resolution.variants.find(variant => info(variant.reference).contentId === info(found.reference).contentId);
        if (previous) { previous.targets.push(target); resolution.deduplicatedVersions++; }
        else resolution.variants.push({ reference: found.reference, targets: [target] });
        return false;
      });
    }
    for (const id of pending) resolved.get(id)!.missingVersions++;
  }
  return resolved;
}

async function request(client: NeteaseClient, ref: MediaReference, range?: { start: number; end: number }): Promise<Response> {
  const current = (await resolveMedia(client, [ref.id], ref.level)).get(ref.id);
  if (!current) fail('unavailable', '网易云当前未提供此完整音频版本。');
  if (info(current.reference).contentId !== info(ref).contentId) fail('content_changed', '网易云音频版本已变化，请刷新目录。');
  const response = await client.ctx.fetch(current.url, { signal: client.ctx.signal, headers: { 'Accept-Encoding': 'identity', ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) } });
  if (!response.body || !response.ok) { await response.body?.cancel(); fail(response.status === 416 ? 'content_changed' : 'temporary', '网易云音频读取暂未成功。'); }
  return response;
}
function verify(response: Response, ref: MediaReference, range?: { start: number; end: number }) {
  if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') fail('not_supported', '网易云音频响应的内容编码不受支持。');
  if (range ? response.status !== 206 || response.headers.get('content-range') !== `bytes ${range.start}-${range.end}/${ref.size}` : response.status !== 200) fail('not_supported', '网易云音频响应与请求范围不符。');
  const length = response.headers.get('content-length');
  if (!length || !/^\d+$/.test(length) || Number(length) !== (range ? range.end - range.start + 1 : ref.size)) fail('temporary', '网易云音频响应长度不一致。');
}
export async function stat(client: NeteaseClient, file: string): Promise<FileInfo> {
  const ref = decodeFile(file); const range = { start: 0, end: 0 }; const response = await request(client, ref, range);
  try { verify(response, ref, range); return info(ref); }
  finally { await response.body?.cancel(); }
}
export async function open(client: NeteaseClient, file: string, input: ReadRequest): Promise<ReadResult> {
  const ref = decodeFile(file);
  if (input.expectedContentId !== info(ref).contentId) fail('content_changed', '网易云文件版本已变化。');
  if (input.range && (!Number.isSafeInteger(input.range.start) || !Number.isSafeInteger(input.range.end) || input.range.start < 0 || input.range.end < input.range.start || input.range.end >= ref.size)) fail('not_supported', '无效的网易云音频范围。');
  const response = await request(client, ref, input.range);
  try { verify(response, ref, input.range); return { content: info(ref), servedRange: input.range ?? null, body: response.body! }; }
  catch (error) { await response.body?.cancel(); throw error; }
}
