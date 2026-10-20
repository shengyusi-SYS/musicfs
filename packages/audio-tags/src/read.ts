import type { ByteRange, FileInfo, ReadResult } from '@musicfs/plugin-api';
import { AudioTagError, type PrepareOptions } from './types';

export async function verifyRead(result: ReadResult, expected: FileInfo, range: ByteRange): Promise<void> {
  if (result.content.contentId !== expected.contentId || result.content.size !== expected.size
    || result.content.mediaType !== expected.mediaType || result.servedRange?.start !== range.start
    || result.servedRange.end !== range.end) {
    await result.body.cancel().catch(() => {});
    throw new AudioTagError('content_changed', 'The source bytes changed while preparing or reading audio tags.');
  }
}
export async function readBytes(options: PrepareOptions, start: number, end: number): Promise<Uint8Array> {
  options.signal.throwIfAborted();
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= options.sourceInfo.size) {
    throw new AudioTagError('not_supported', 'The audio metadata extends beyond this source file.');
  }
  const range = { start, end };
  const result = await options.readRange(range, options.signal);
  await verifyRead(result, options.sourceInfo, range);
  const reader = result.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel(options.signal.reason).catch(() => {}); };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    options.signal.throwIfAborted();
    while (true) {
      const part = await reader.read();
      options.signal.throwIfAborted();
      if (part.done) break;
      length += part.value.length;
      if (length > end - start + 1) throw new AudioTagError('content_changed', 'The source returned bytes outside the requested range.');
      chunks.push(part.value);
    }
    if (length !== end - start + 1) throw new AudioTagError('temporary', 'The source audio metadata read ended early.');
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    options.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
