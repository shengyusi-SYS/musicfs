import type { ByteRange, FileInfo, ReadRequest, ReadResult } from '@musicfs/plugin-api';
import { endpoints } from './generated-upstream.mjs';
import { fail, rateLimited, object, type NeteaseClient } from './client';
import { audioPolicy, lowerQualities, qualities, type Quality } from './configuration';
import { decodeTagged, taggedOpen, taggedStat } from './tagged';
import type { ReadRange } from '@musicfs/audio-tags';
import { decodeFile, info, reference, type MediaReference } from './reference';
import { multiRange } from './multi-range';
export { decodeFile, info, type MediaReference } from './reference';

type Location = { reference: MediaReference; url: string; expiresAt?: number };
type Variant = { reference: MediaReference; targets: Quality[]; location: Location };
export type Resolution = { variants: Variant[]; missingVersions: number; fallbackVersions: number; deduplicatedVersions: number };
export function resolutionKey(client: NeteaseClient, id: string) {
  const policy = audioPolicy(client.ctx.config);
  return `versions:${policy.qualities.join(',')}:${policy.missingQuality}:${id}`;
}
async function invalidateResolution(client: NeteaseClient, id: string) {
  await client.ctx.cache?.put(resolutionKey(client, id), null, { expiresAt: Date.now() });
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
    perTrack.set(parsed.data.level, { reference: parsed.data, url: mediaUrl(item.url),
      ...(typeof item.expi === 'number' && Number.isFinite(item.expi) && item.expi > 0 ? { expiresAt: Date.now() + item.expi * 1000 } : {}) }); candidates.set(id, perTrack);
  }
  if (seen.size !== requested.size) fail('temporary', '网易云音频列表未完整返回。');
  for (const id of requested) {
    const available = candidates.get(id);
    const best = eligible.find(level => available?.has(level));
    if (best) result.set(id, available!.get(best)!);
  }
  return result;
}

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
        else resolution.variants.push({ reference: found.reference, targets: [target], location: found });
        return false;
      });
    }
    for (const id of pending) resolved.get(id)!.missingVersions++;
  }
  return resolved;
}

async function request(client: NeteaseClient, ref: MediaReference, range?: ByteRange | readonly ByteRange[], location?: Location, signal = client.ctx.signal): Promise<Response> {
  const current = location ?? (await resolveMedia(client, [ref.id], ref.level)).get(ref.id);
  if (!current) { await invalidateResolution(client, ref.id); fail('unavailable', '网易云当前未提供此完整音频版本。'); }
  if (info(current.reference).contentId !== info(ref).contentId) { await invalidateResolution(client, ref.id); fail('content_changed', '网易云音频版本已变化，请刷新目录。'); }
  const ranges = range && ('start' in range ? [range] : range);
  const response = await client.ctx.fetch(current.url, { signal: signal === client.ctx.signal ? signal : AbortSignal.any([client.ctx.signal, signal]), headers: { 'Accept-Encoding': 'identity', ...(ranges ? { Range: `bytes=${ranges.map(range => `${range.start}-${range.end}`).join(',')}` } : {}) } });
  if (response.status === 429) { await response.body?.cancel(); rateLimited(response); }
  if (!response.body || !response.ok) { await response.body?.cancel(); await invalidateResolution(client, ref.id); fail(response.status === 416 ? 'content_changed' : 'temporary', '网易云音频读取暂未成功。'); }
  return response;
}
function verify(response: Response, ref: MediaReference, range?: { start: number; end: number }) {
  if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') fail('not_supported', '网易云音频响应的内容编码不受支持。');
  if (range ? response.status !== 206 || response.headers.get('content-range') !== `bytes ${range.start}-${range.end}/${ref.size}` : response.status !== 200) fail('not_supported', '网易云音频响应与请求范围不符。');
  const length = response.headers.get('content-length');
  if (!length || !/^\d+$/.test(length) || Number(length) !== (range ? range.end - range.start + 1 : ref.size)) fail('temporary', '网易云音频响应长度不一致。');
}
export async function stat(client: NeteaseClient, file: string): Promise<FileInfo> {
  const tagged = decodeTagged(file);
  if (tagged) return taggedStat(client, tagged);
  const ref = decodeFile(file); const range = { start: 0, end: 0 }; const response = await request(client, ref, range);
  try { verify(response, ref, range); return info(ref); }
  finally { await response.body?.cancel(); }
}
export async function open(client: NeteaseClient, file: string, input: ReadRequest): Promise<ReadResult> {
  const tagged = decodeTagged(file);
  if (tagged) return taggedOpen(client, tagged, input, sourceReader(client, tagged.source));
  return rawOpen(client, file, input);
}
export async function rawOpen(client: NeteaseClient, file: string, input: ReadRequest, location?: Location, signal = client.ctx.signal): Promise<ReadResult> {
  const ref = decodeFile(file);
  if (input.expectedContentId !== info(ref).contentId) fail('content_changed', '网易云文件版本已变化。');
  if (input.range && (!Number.isSafeInteger(input.range.start) || !Number.isSafeInteger(input.range.end) || input.range.start < 0 || input.range.end < input.range.start || input.range.end >= ref.size)) fail('not_supported', '无效的网易云音频范围。');
  const response = await request(client, ref, input.range, location, signal);
  try { verify(response, ref, input.range); return { content: info(ref), servedRange: input.range ?? null, body: response.body! }; }
  catch (error) { await response.body?.cancel(); throw error; }
}

const unsupportedMultiRange = new WeakMap<NeteaseClient, Set<string>>();
export function sourceReader(client: NeteaseClient, ref: MediaReference, location?: Location): ReadRange {
  let located: Promise<Location | undefined> | undefined = location && (location.expiresAt === undefined || location.expiresAt > Date.now()) ? Promise.resolve(location) : undefined;
  const locate = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const current = await (located ??= resolveMedia(client, [ref.id], ref.level).then(values => values.get(ref.id)));
    if (!current) { await invalidateResolution(client, ref.id); fail('unavailable', '网易云当前未提供此完整音频版本。'); }
    signal.throwIfAborted(); return current;
  };
  const read: ReadRange = async (range, signal) => rawOpen(client, JSON.stringify(ref), { expectedContentId: info(ref).contentId, range }, await locate(signal), signal);
  read.readMany = async (ranges, signal) => {
    if (!ranges.length) return [];
    const current = await locate(signal); const host = new URL(current.url).host;
    const singles = async () => {
      const results: ReadResult[] = [];
      try { for (const range of ranges) results.push(await read(range, signal)); return results; }
      catch (error) { await Promise.all(results.map(result => result.body.cancel().catch(() => {}))); throw error; }
    };
    // Preparation only combines two small metadata windows, never whole files.
    if (ranges.length !== 2 || ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0) > 16_384
      || unsupportedMultiRange.get(client)?.has(host)) return singles();
    for (const range of ranges) if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end >= ref.size) fail('not_supported', '无效的网易云音频范围。');
    const response = await request(client, ref, ranges, current, signal);
    const results = await multiRange(response, ref, ranges, signal === client.ctx.signal ? signal : AbortSignal.any([client.ctx.signal, signal]));
    if (results) return results;
    let unsupported = unsupportedMultiRange.get(client);
    if (!unsupported) { unsupported = new Set(); unsupportedMultiRange.set(client, unsupported); }
    unsupported.add(host); return singles();
  };
  return read;
}
