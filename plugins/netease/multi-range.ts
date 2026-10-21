import type { ByteRange, ReadResult } from '@musicfs/plugin-api';
import { getMultipartBoundary, parseMultipart, type MultipartPart } from '@remix-run/multipart-parser';
import { fail } from './client';
import { info, type MediaReference } from './reference';

async function boundedBody(response: Response, signal: AbortSignal, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) fail('temporary', '网易云多范围音频响应长度不一致。');
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
      if (part.done) break;
      length += part.value.length;
      if (length > limit) fail('temporary', '网易云多范围音频响应超出了资料范围。');
      chunks.push(part.value);
    }
    if (declared && Number(declared) !== length) fail('temporary', '网易云多范围音频响应提前结束。');
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

/** undefined means an ordinary server explicitly ignored the multi-range request. */
export async function multiRange(response: Response, ref: MediaReference, ranges: readonly ByteRange[], signal: AbortSignal): Promise<ReadResult[] | undefined> {
  if (response.status === 200) { await response.body!.cancel(); return; }
  try {
    if (response.status !== 206) fail('not_supported', '网易云音频响应与请求范围不符。');
    if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') fail('not_supported', '网易云音频响应的内容编码不受支持。');
    const single = response.headers.get('content-range');
    if (single) {
      const range = ranges.find(range => single === `bytes ${range.start}-${range.end}/${ref.size}`);
      if (!range) fail('content_changed', '网易云音频响应的文件或区段已变化。');
      const length = response.headers.get('content-length');
      if (length && Number(length) !== range.end - range.start + 1) fail('temporary', '网易云音频响应长度不一致。');
      await response.body!.cancel(); return;
    }
    const sizes = ranges.map(range => range.end - range.start + 1);
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const bytes = await boundedBody(response, signal, total + 8192);
    // This CDN sometimes labels valid multipart bytes audio/mpeg. Only discover
    // its opening delimiter here; the standard parser owns the MIME structure.
    const header = response.headers.get('content-type') ?? '';
    const boundary = getMultipartBoundary(header)
      ?? /^(?:\r\n)?--([^\r\n]{1,70})\r\n/.exec(new TextDecoder().decode(bytes.subarray(0, 76)))?.[1];
    if (!boundary) fail('not_supported', '网易云未返回可识别的多范围音频。');
    let parts: MultipartPart[];
    try { parts = [...parseMultipart(bytes, { boundary, maxParts: ranges.length, maxHeaderSize: 2048,
      maxFileSize: Math.max(...sizes), maxTotalSize: total })]; }
    catch { fail('temporary', '网易云多范围音频响应不完整或无法解析。'); }
    if (parts.length !== ranges.length) fail('temporary', '网易云未返回完整的音频资料区段。');
    const results: (ReadResult | undefined)[] = new Array(ranges.length);
    for (const part of parts) {
      const index = ranges.findIndex(range => part.headers['content-range'] === `bytes ${range.start}-${range.end}/${ref.size}`);
      if (index < 0 || results[index]) fail('content_changed', '网易云音频响应的文件或区段已变化。');
      const range = ranges[index]!; const data = part.bytes;
      if (data.length !== sizes[index]) fail('content_changed', '网易云音频区段长度不一致。');
      results[index] = { content: info(ref), servedRange: { ...range }, body: new Response(new Uint8Array(data)).body! };
    }
    return results as ReadResult[];
  } catch (error) { await response.body!.cancel().catch(() => {}); throw error; }
}
