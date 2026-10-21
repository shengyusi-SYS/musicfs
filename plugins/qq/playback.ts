import { z } from 'zod';
import type { FileInfo, ReadResult } from '@musicfs/plugin-api';
import { fail, object, QqFailure, QqRequestBudgetFailure, type QqClient } from './client';
import { audioPolicy, lowerQualities, qualities, type Quality } from './configuration';
import { apeFileFailureOf, credentialMusicId, MUSIC_FILE_TYPES, StreamCdnSelector } from './generated-upstream.mjs';
import { describe } from './file-info';

export type Track = { mid: string; file: { media_mid: string; [key: string]: unknown } };
export const trackKey = (track: Track) => `${track.mid}:${track.file.media_mid}`;
const fileSchema = z.object({ version: z.literal(1), mid: z.string().regex(/^[A-Za-z0-9]+$/), mediaId: z.string().regex(/^[A-Za-z0-9]+$/),
  quality: z.enum(qualities), filename: z.string().regex(/^[A-Za-z0-9]+\.(mp3|m4a|flac|ape)$/) }).strict()
  .refine(value => value.filename.startsWith(MUSIC_FILE_TYPES[value.quality].prefix) && value.filename.endsWith(MUSIC_FILE_TYPES[value.quality].extension));
export type MediaReference = z.infer<typeof fileSchema>;
export function decodeFile(file: string): MediaReference {
  try { return fileSchema.parse(JSON.parse(file)); } catch { return fail('not_found', 'QQ 文件引用无效。'); }
}
type Candidate = { track: Track; quality: Quality };
type Location = { quality: Quality; filename: string; purl: string; sip: string[] };
type Variant = { quality: Quality; fileRef: string; targets: Quality[]; info: FileInfo; location: URL };
type Resolution = { variants: Variant[]; missingVersions: number; fallbackVersions: number; deduplicatedVersions: number };
const candidateKey = ({ track, quality }: Candidate) => `${trackKey(track)}:${quality}`;
const filenameOf = ({ track, quality }: Candidate) => `${MUSIC_FILE_TYPES[quality].prefix}${track.mid}${track.file.media_mid}${MUSIC_FILE_TYPES[quality].extension}`;

/** Native vkey batches retain each track's media ID; the facade accepts only one media ID per call. */
async function locations(client: QqClient, inputs: Candidate[]): Promise<Map<string, Location | null>> {
  const result = new Map<string, Location | null>();
  const missingApe = inputs.filter(input => input.quality === 'ape' && apeFileFailureOf(input.track) === 'quality-detail-unavailable');
  const details = new Map<string, unknown>();
  for (let start = 0; start < missingApe.length; start += 20) {
    const batch = missingApe.slice(start, start + 20);
    const found = await client.rpcBatch(() => batch.map(input => ({ module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq',
      param: { song_type: 0, song_mid: input.track.mid }, readOnly: true, operation: 'session.authenticated-read' })));
    batch.forEach((input, index) => details.set(trackKey(input.track), found[index]?.track_info));
  }
  const usable = inputs.filter(input => {
    if (input.quality !== 'ape') return true;
    const reason = apeFileFailureOf(details.has(trackKey(input.track)) ? details.get(trackKey(input.track)) : input.track);
    if (reason === 'quality-detail-unavailable') fail('temporary', 'QQ APE 文件信息暂时无法确认，请稍后刷新。');
    if (reason === 'quality-file-unavailable') { result.set(candidateKey(input), null); return false; }
    return true;
  });
  const batches: Candidate[][] = [];
  for (const quality of qualities) {
    const group = usable.filter(input => input.quality === quality);
    for (let start = 0; start < group.length; start += 50) batches.push(group.slice(start, start + 50));
  }
  // Bound descriptors per transport call as well as songs per descriptor.
  for (let start = 0; start < batches.length; start += 10) {
    const batch = batches.slice(start, start + 10);
    const responses = await client.rpcBatch(session => batch.map(items => ({ module: 'music.vkey.GetVkey', method: 'UrlGetVkey',
      param: { filename: items.map(filenameOf), guid: crypto.randomUUID().replaceAll('-', ''), songmid: items.map(item => item.track.mid),
        songtype: items.map(() => 0), uin: credentialMusicId(session.credential), ctx: 0 }, readOnly: true, operation: 'session.authenticated-read' })));
    batch.forEach((items, index) => {
      const body = responses[index]!;
      if (body.retcode !== undefined && body.retcode !== 0) fail('temporary', 'QQ 音频解析暂未成功。');
      if (!Array.isArray(body.midurlinfo) || body.midurlinfo.length !== items.length || body.sip !== undefined && (!Array.isArray(body.sip) || body.sip.some(value => typeof value !== 'string'))) {
        fail('temporary', 'QQ 返回了不完整的音频解析结果。');
      }
      const entries = new Map<string, Record<string, unknown>>();
      for (const raw of body.midurlinfo) {
        const entry = object(raw);
        if (typeof entry.filename !== 'string' || entries.has(entry.filename)) fail('temporary', 'QQ 音频结果的文件身份无效。');
        entries.set(entry.filename, entry);
      }
      for (const input of items) {
        const entry = entries.get(filenameOf(input));
        if (!entry || entry.songmid !== input.track.mid || typeof entry.purl !== 'string') fail('temporary', 'QQ 音频结果与所请求的歌曲不一致。');
        const key = candidateKey(input);
        if (!entry.purl) { result.set(key, null); continue; }
        let relative: URL;
        try { relative = new URL(entry.purl, 'https://media.musicfs.invalid/'); } catch { return fail('temporary', 'QQ 返回了无效的音频位置。'); }
        if (relative.origin !== 'https://media.musicfs.invalid' || relative.hash) fail('temporary', 'QQ 返回了无法识别的音频位置。');
        const filename = relative.pathname.slice(1);
        if (/^RS02[A-Za-z0-9]+\.mp3$/.test(filename)) { result.set(key, null); continue; }
        // Native requests use songmid + media_mid; real replies canonicalize the path to media_mid alone.
        // The requested filename and songmid above still bind this reply to its exact input.
        const actual = qualities.find(quality => filename === filenameOf({ ...input, quality })
          || filename === `${MUSIC_FILE_TYPES[quality].prefix}${input.track.file.media_mid}${MUSIC_FILE_TYPES[quality].extension}`);
        if (!actual) fail('content_changed', 'QQ 返回的实际音频身份或格式与歌曲不一致。');
        result.set(key, { quality: actual, filename, purl: entry.purl, sip: body.sip as string[] | undefined ?? [] });
      }
    });
  }
  return result;
}

export async function resolveVariants(client: QqClient, tracks: Track[]): Promise<Map<string, Resolution>> {
  const policy = audioPolicy(client.ctx.config);
  const unique = new Map(tracks.map(track => [trackKey(track), track]));
  const targets = qualities.filter(quality => policy.qualities.includes(quality));
  const slots = [...unique.values()].flatMap(track => targets.map(target => ({ track, target, index: 0, done: false,
    chain: [target, ...(policy.missingQuality === 'fallback' ? lowerQualities(target) : [])], found: null as Location | null })));
  const cache = new Map<string, Location | null>();
  while (slots.some(slot => !slot.done)) {
    const pending = new Map<string, Candidate>();
    for (const slot of slots) if (!slot.done) {
      const candidate = { track: slot.track, quality: slot.chain[slot.index]! };
      if (!cache.has(candidateKey(candidate))) pending.set(candidateKey(candidate), candidate);
    }
    if (pending.size) for (const [key, location] of await locations(client, [...pending.values()])) cache.set(key, location);
    for (const slot of slots) if (!slot.done) {
      const candidate = { track: slot.track, quality: slot.chain[slot.index]! };
      const found = cache.get(candidateKey(candidate));
      if (found && (found.quality === slot.target || policy.missingQuality === 'fallback' && lowerQualities(slot.target).includes(found.quality))) {
        slot.found = found; slot.done = true;
      } else {
        if (found && found.quality !== slot.target && !lowerQualities(slot.target).includes(found.quality)) fail('content_changed', 'QQ 返回了所选音质范围之外的版本。');
        slot.done = ++slot.index >= slot.chain.length;
      }
    }
  }
  const resolved = new Map<string, Resolution>();
  const prepared = new Map<string, { url: URL; info: FileInfo }>();
  for (const [key, track] of unique) {
    const variants = new Map<string, Variant>(); let missingVersions = 0; let fallbackVersions = 0; let deduplicatedVersions = 0;
    for (const slot of slots.filter(slot => trackKey(slot.track) === key)) {
      if (!slot.found) { missingVersions++; continue; }
      if (slot.found.quality !== slot.target) fallbackVersions++;
      const previous = variants.get(slot.found.filename);
      if (previous) { previous.targets.push(slot.target); deduplicatedVersions++; continue; }
      const reference = fileSchema.parse({ version: 1, mid: track.mid, mediaId: track.file.media_mid,
        quality: slot.found.quality, filename: slot.found.filename });
      let located = prepared.get(reference.filename);
      if (!located) { located = await selectLocation(client, slot.found); prepared.set(reference.filename, located); }
      variants.set(reference.filename, { quality: reference.quality, targets: [slot.target], fileRef: JSON.stringify(reference), info: located.info, location: located.url });
    }
    resolved.set(key, { variants: [...variants.values()], missingVersions, fallbackVersions, deduplicatedVersions });
  }
  return resolved;
}

/** Resolve only the referenced actual version. Reads must never fall back to different bytes. */
async function fileLocation(client: QqClient, ref: MediaReference): Promise<Location> {
  const input: Candidate = { track: { mid: ref.mid, file: { media_mid: ref.mediaId } }, quality: ref.quality };
  const found = (await locations(client, [input])).get(candidateKey(input));
  if (!found) fail('unavailable', '此 QQ 音频当前不可读取。');
  if (found.filename !== ref.filename || found.quality !== ref.quality) fail('content_changed', 'QQ 音频文件已变化，请刷新目录。');
  return found;
}
export async function locateFile(client: QqClient, ref: MediaReference): Promise<{ url: URL; info: FileInfo }> {
  return selectLocation(client, await fileLocation(client, ref));
}

/** A routing preference is reusable; signed URLs, entitlement and file identity are not. */
export async function readFileLocation(client: QqClient, ref: MediaReference,
  read: (url: URL, signal: AbortSignal) => Promise<ReadResult>, signal: AbortSignal) {
  signal.throwIfAborted();
  const found = await fileLocation(client, ref);
  const cache = client.ctx.cache;
  const key = 'stream-base';
  let saved = cache ? await cache.get(key) : undefined;
  const preferred = typeof saved === 'string' && found.sip.includes(saved) ? saved : undefined;
  signal.throwIfAborted();
  if (preferred) {
    // Let the SDK validate the base. The actual response replaces the probe;
    // its caller validates the exact saved representation before exposing bytes.
    let result: ReadResult | undefined;
    const headers = new AbortController();
    const timer = setTimeout(() => headers.abort(new DOMException('CDN headers timed out', 'TimeoutError')), 5000);
    try {
      const selector = new StreamCdnSelector(async url => {
        result = await read(new URL(url), AbortSignal.any([signal, headers.signal]));
        return { bytes: 1, elapsedMs: 1 };
      });
      const base = await selector.select([preferred], found.purl);
      if (base && result) return { url: new URL(found.purl, base), info: result.content, result };
    } catch (error) {
      signal.throwIfAborted(); client.ctx.signal.throwIfAborted();
      // One stale route may return to the existing bounded selector, before a
      // response body escapes. Never retry a different representation or rate limit.
      if (!(error instanceof QqFailure && error.fault.kind === 'temporary')
        && !(error instanceof TypeError) && !headers.signal.aborted) throw error;
      await cache!.put(key, null, { expiresAt: Date.now() });
      saved = undefined;
    } finally { clearTimeout(timer); }
  }
  signal.throwIfAborted();
  const located = await selectLocation(client, found);
  signal.throwIfAborted();
  const result = await read(located.url, signal);
  try {
    if (cache && saved !== located.base) await cache.put(key, located.base, { expiresAt: Date.now() + 30 * 60_000 });
    return { ...located, result };
  } catch (error) { await result.body.cancel(); throw error; }
}

/** Reuse the list's native location and the winning SDK probe's exact metadata. */
async function selectLocation(client: QqClient, found: Location): Promise<{ url: URL; info: FileInfo; base: string }> {
  // A selector belongs to this invocation; its cached promise never crosses instances or requests.
  let ignoredRange = false;
  let invalidMetadata = false;
  const descriptions = new Map<string, FileInfo>();
  const selector = new StreamCdnSelector(async url => {
    let response: Response | undefined; const started = Date.now();
    try {
      response = await client.ctx.fetch(url, { redirect: 'manual', headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' },
        signal: AbortSignal.any([client.ctx.signal, AbortSignal.timeout(5000)]) });
      if (response.status === 200) ignoredRange = true;
      if (response.status !== 206 || !/^bytes 0-0\/\d+$/.test(response.headers.get('content-range') ?? '') || !response.body) return null;
      const info = describe(response, found, true);
      if (!info || response.headers.get('content-length') !== '1') { invalidMetadata = true; return null; }
      const reader = response.body.getReader();
      try {
        const piece = await reader.read();
        if (piece.value?.byteLength !== 1) return null;
        descriptions.set(url, info);
        return { bytes: 1, elapsedMs: Math.max(1, Date.now() - started) };
      }
      finally { await reader.cancel(); }
    } catch (error) { client.ctx.signal.throwIfAborted(); if (error instanceof QqRequestBudgetFailure) throw error; return null; }
    finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  });
  let base = await selector.select(found.sip.length ? found.sip.slice(0, 4) : ['http://sjy6.stream.qqmusic.qq.com/'], found.purl);
  if (!base) {
    const dispatch = await client.rpc(() => ({ module: 'music.audioCdnDispatch.cdnDispatch', method: 'GetCdnDispatch',
      param: { guid: crypto.randomUUID().replaceAll('-', ''), uid: '0', use_new_domain: 1, use_ipv6: 1 }, readOnly: true, operation: 'session.authenticated-read' }));
    if (!Array.isArray(dispatch.sip) || dispatch.sip.some(value => typeof value !== 'string')) fail('temporary', 'QQ 音频分发地址暂时无效。');
    base = await selector.select([...dispatch.sip.slice(0, 4), 'http://dl.stream.qqmusic.qq.com/'], found.purl);
  }
  client.ctx.signal.throwIfAborted();
  if (!base) fail(ignoredRange || invalidMetadata ? 'not_supported' : 'temporary', ignoredRange ? 'QQ 音频地址没有按请求返回范围。'
    : invalidMetadata ? 'QQ 音频未提供可核对的完整文件信息。' : 'QQ 音频地址暂时无法连接，请稍后重试。');
  const url = new URL(found.purl, base); const info = descriptions.get(url.href);
  if (!info) fail(invalidMetadata ? 'not_supported' : 'temporary', 'QQ 音频的完整文件信息暂时无法确认。');
  return { url, info, base };
}
