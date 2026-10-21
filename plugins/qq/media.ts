import type { FileInfo, ReadRequest, ReadResult } from '@musicfs/plugin-api';
import { fail, QqFailure, type QqClient } from './client';
import { decodeFile, locateFile, readFileLocation } from './playback';
import { describe } from './file-info';
import { decodeTagged, taggedOpen, taggedStat } from './tagged';
import type { ReadRange } from '@musicfs/audio-tags';

async function request(client: QqClient, range: { start: number; end: number } | undefined, location: URL, signal: AbortSignal): Promise<Response> {
  client.requireSession();
  const response = await client.ctx.fetch(location, { redirect: 'manual', signal: signal === client.ctx.signal ? signal : AbortSignal.any([client.ctx.signal, signal]), headers: { 'Accept-Encoding': 'identity',
    ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) } });
  if (!response.body || !response.ok) {
    await response.body?.cancel();
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      throw new QqFailure({ kind: 'rate_limited', message: 'QQ 音频请求过于频繁，请稍后重试。',
        ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterSeconds: Math.ceil(seconds) } : {}) });
    }
    fail(response.status === 416 ? 'content_changed' : 'temporary', 'QQ 音频请求暂未成功。');
  }
  return response;
}

export async function stat(client: QqClient, file: string): Promise<FileInfo> {
  const tagged = decodeTagged(file);
  if (tagged) return taggedStat(client, tagged);
  return (await locateFile(client, decodeFile(file))).info;
}

export async function open(client: QqClient, file: string, input: ReadRequest): Promise<ReadResult> {
  const tagged = decodeTagged(file);
  if (tagged) return taggedOpen(client, tagged, input, source => sourceReader(client, JSON.stringify(tagged.source), source));
  return rawOpen(client, file, input);
}

/** The tagging adapter reads the exact immutable source representation from its saved plan. */
export async function rawOpen(client: QqClient, file: string, input: ReadRequest, location?: URL, signal = client.ctx.signal): Promise<ReadResult> {
  const ref = decodeFile(file);
  if (input.range && (!Number.isSafeInteger(input.range.start) || !Number.isSafeInteger(input.range.end) || input.range.start < 0 || input.range.end < input.range.start)) fail('not_supported', '无效的音频范围。');
  signal.throwIfAborted();
  if (!location) return (await readFileLocation(client, ref, (url, readSignal) => rawOpen(client, file, input, url, readSignal), signal)).result;
  const response = await request(client, input.range, location, signal);
  try {
    const partial = input.range !== undefined;
    if (partial ? response.status !== 206 : response.status !== 200) fail('not_supported', 'QQ 音频响应与请求范围不符。');
    const content = describe(response, ref, partial);
    if (!content) fail('not_supported', 'QQ 音频没有提供可核对的完整文件信息。');
    if (content.contentId !== input.expectedContentId) fail('content_changed', 'QQ 音频版本已变化，请重新读取。');
    if (input.range && response.headers.get('content-range') !== `bytes ${input.range.start}-${input.range.end}/${content.size}`) fail('not_supported', 'QQ 音频返回了不同范围。');
    const length = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length !== (input.range ? input.range.end - input.range.start + 1 : content.size)) fail('temporary', 'QQ 音频响应长度不一致。');
    return { content, servedRange: input.range ?? null, body: response.body! };
  } catch (error) { await response.body?.cancel(); throw error; }
}

/** All tag ranges in this call share one resolved locator; no signed URL survives in the plan. */
export function sourceReader(client: QqClient, file: string, info: FileInfo, location?: URL): ReadRange {
  const ref = decodeFile(file);
  let located: ReturnType<typeof locateFile> | undefined = location ? Promise.resolve({ url: location, info }) : undefined;
  return async (range, signal) => {
    signal.throwIfAborted();
    if (!located) {
      const pending = readFileLocation(client, ref, (url, readSignal) => rawOpen(client, file, { expectedContentId: info.contentId, range }, url, readSignal), signal);
      located = pending.then(value => ({ url: value.url, info: value.info }));
      // A failed location is shared by all pending reads in this invocation.
      await located;
      return (await pending).result;
    }
    const current = await located;
    if (current.info.contentId !== info.contentId) fail('content_changed', 'QQ 音频版本已变化，请重新刷新目录。');
    return rawOpen(client, file, { expectedContentId: info.contentId, range }, current.url, signal);
  };
}
