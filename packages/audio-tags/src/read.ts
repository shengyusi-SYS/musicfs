import type { ByteRange, FileInfo, ReadResult } from '@musicfs/plugin-api';
import { AudioTagError, type PrepareOptions, type ReadRange } from './types';

/** Preparation-local header/tail windows. Open streams keep their original exact reader. */
export function bufferedRanges(options: PrepareOptions): ReadRange {
  const windows: { start: number; end: number; bytes: Uint8Array }[] = [];
  let initial: Promise<void> | undefined;
  const remember = (range: ByteRange, bytes: Uint8Array) => {
    const window = { ...range, bytes };
    if (bytes.length <= 65_536) { windows.push(window); if (windows.length > 2) windows.shift(); }
    return window;
  };
  async function readEnds() {
    const last = options.sourceInfo.size - 1;
    const ranges = [{ start: 0, end: Math.min(last, 4095) }, { start: Math.max(0, last - 4095), end: last }];
    // Small files need only one ordinary read, rather than overlapping multipart parts.
    if (ranges[0]!.end + 1 >= ranges[1]!.start) {
      const range = { start: 0, end: last };
      remember(range, await readBytes(options, range.start, range.end)); return;
    }
    const results = await options.readRange.readMany!(ranges, options.signal);
    try {
      if (results.length !== ranges.length) throw new AudioTagError('temporary', 'The source returned an incomplete set of audio metadata ranges.');
      for (const [index, range] of ranges.entries()) remember(range, await resultBytes(options, range, results[index]!));
    } catch (error) {
      await Promise.all(results.map(result => result.body.cancel().catch(() => {})));
      throw error;
    }
  }
  return async (range, signal) => {
    signal.throwIfAborted();
    if (options.readRange.readMany && (options.format === 'mp3' || options.format === 'ape')) await (initial ??= readEnds());
    let window = windows.find(value => value.start <= range.start && value.end >= range.end);
    if (!window) {
      // MP4 boxes declare exact boundaries; never prefetch through an mdat payload.
      const start = options.format === 'm4a' ? range.start : Math.floor(range.start / 4096) * 4096;
      const end = options.format === 'm4a' ? range.end : Math.min(options.sourceInfo.size - 1, Math.max(range.end, start + 4095));
      window = remember({ start, end }, await readBytes(options, start, end));
    }
    signal.throwIfAborted();
    return { content: options.sourceInfo, servedRange: range,
      body: new Response(new Uint8Array(window.bytes.subarray(range.start - window.start, range.end - window.start + 1))).body! };
  };
}

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
  return resultBytes(options, range, result);
}

async function resultBytes(options: PrepareOptions, range: ByteRange, result: ReadResult): Promise<Uint8Array> {
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
      if (length > range.end - range.start + 1) throw new AudioTagError('content_changed', 'The source returned bytes outside the requested range.');
      chunks.push(part.value);
    }
    if (length !== range.end - range.start + 1) throw new AudioTagError('temporary', 'The source audio metadata read ended early.');
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
