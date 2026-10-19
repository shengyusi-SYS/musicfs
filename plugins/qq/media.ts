import type { FileInfo, ReadRequest, ReadResult } from '@musicfs/plugin-api';
import { fail, type QqClient } from './client';
import { decodeFile, formats, locateFile, type MediaReference } from './playback';

function description(response: Response, ref: MediaReference, partial: boolean): FileInfo {
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding !== 'identity') fail('not_supported', 'QQ 音频响应使用了不支持的内容编码。');
  const matched = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  const raw = partial ? matched?.[3] : response.headers.get('content-length');
  const size = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(size) || size <= 0) fail('temporary', 'QQ 音频大小暂时无法确认。');
  const revision = response.headers.get('etag') ?? response.headers.get('last-modified');
  if (!revision) fail('not_supported', 'QQ 音频未提供可核对的内容版本。');
  return { contentId: JSON.stringify([ref.filename, size, revision]), size, mediaType: formats[ref.quality].mediaType };
}

async function request(client: QqClient, ref: MediaReference, range?: { start: number; end: number }): Promise<Response> {
  client.requireSession();
  const url = await locateFile(client, ref);
  const response = await client.ctx.fetch(url, { signal: client.ctx.signal, headers: { 'Accept-Encoding': 'identity',
    ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) } });
  if (!response.body || !response.ok) { await response.body?.cancel(); fail(response.status === 416 ? 'content_changed' : 'temporary', 'QQ 音频请求暂未成功。'); }
  return response;
}

export async function stat(client: QqClient, file: string): Promise<FileInfo> {
  const ref = decodeFile(file); const response = await request(client, ref, { start: 0, end: 0 });
  try {
    if (response.status !== 206 || !/^bytes 0-0\/\d+$/.test(response.headers.get('content-range') ?? '')) fail('not_supported', 'QQ 音频未按请求返回范围。');
    return description(response, ref, true);
  } finally { await response.body?.cancel(); }
}

export async function open(client: QqClient, file: string, input: ReadRequest): Promise<ReadResult> {
  const ref = decodeFile(file);
  if (input.range && (!Number.isSafeInteger(input.range.start) || !Number.isSafeInteger(input.range.end) || input.range.start < 0 || input.range.end < input.range.start)) fail('not_supported', '无效的音频范围。');
  const response = await request(client, ref, input.range);
  try {
    const partial = input.range !== undefined;
    if (partial ? response.status !== 206 : response.status !== 200) fail('not_supported', 'QQ 音频响应与请求范围不符。');
    const content = description(response, ref, partial);
    if (content.contentId !== input.expectedContentId) fail('content_changed', 'QQ 音频版本已变化，请重新读取。');
    if (input.range && response.headers.get('content-range') !== `bytes ${input.range.start}-${input.range.end}/${content.size}`) fail('not_supported', 'QQ 音频返回了不同范围。');
    const length = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length !== (input.range ? input.range.end - input.range.start + 1 : content.size)) fail('temporary', 'QQ 音频响应长度不一致。');
    return { content, servedRange: input.range ?? null, body: response.body! };
  } catch (error) { await response.body?.cancel(); throw error; }
}
