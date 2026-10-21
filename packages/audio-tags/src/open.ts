import type { ByteRange, ReadResult } from '@musicfs/plugin-api';
import { AudioTagError, type ReadRange, type TaggedPlan } from './types';
import { decode, segmentSize } from './bytes';
import { verifyRead } from './read';

type Part = { kind: 'bytes'; base64: string; start: number; end: number }
  | { kind: 'zeros'; size: number }
  | { kind: 'source'; range: ByteRange };

/** Read only intersections with the requested final-file range, keeping source audio streaming. */
export async function open(plan: TaggedPlan, readRange: ReadRange, range: ByteRange | undefined,
  signal: AbortSignal): Promise<ReadResult> {
  signal.throwIfAborted();
  if (plan.version !== 1) throw new AudioTagError('not_supported', 'Unsupported cached audio tag plan.');
  const selected = range ?? { start: 0, end: plan.content.size - 1 };
  if (!Number.isSafeInteger(selected.start) || !Number.isSafeInteger(selected.end)
    || selected.start < 0 || selected.end < selected.start || selected.end >= plan.content.size) {
    throw new RangeError('Audio range is outside the final tagged file.');
  }
  const parts: Part[] = [];
  let offset = 0;
  for (const segment of plan.segments) {
    const size = segmentSize(segment);
    const start = Math.max(selected.start, offset);
    const end = Math.min(selected.end, offset + size - 1);
    if (start <= end) parts.push(segment.kind === 'bytes'
      ? { kind: 'bytes', base64: segment.base64, start: start - offset, end: end - offset }
      : segment.kind === 'zeros' ? { kind: 'zeros', size: end - start + 1 }
      : { kind: 'source', range: { start: segment.start + start - offset, end: segment.start + end - offset } });
    offset += size;
  }
  if (offset !== plan.content.size) throw new AudioTagError('content_changed', 'The cached audio tag plan has an incorrect file size.');
  const abortController = new AbortController();
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let activeRemaining = 0;
  let activePart = -1;
  let index = 0;
  let finished = false;
  const stop = () => signal.removeEventListener('abort', abort);
  const abort = () => {
    abortController.abort(signal.reason);
    void activeReader?.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  const getSource = async (part: Extract<Part, { kind: 'source' }>, position: number) => {
    abortController.signal.throwIfAborted();
    const result = await readRange(part.range, abortController.signal);
    await verifyRead(result, plan.source, part.range);
    if (abortController.signal.aborted) {
      await result.body.cancel(abortController.signal.reason).catch(() => {});
      abortController.signal.throwIfAborted();
    }
    activeReader = result.body.getReader();
    activeRemaining = part.range.end - part.range.start + 1;
    activePart = position;
  };
  try {
    // Check the first source response before returning final-file headers; do not buffer its body.
    const firstSource = parts.findIndex(part => part.kind === 'source');
    if (firstSource >= 0) await getSource(parts[firstSource] as Extract<Part, { kind: 'source' }>, firstSource);
    signal.throwIfAborted();
  } catch (error) {
    abortController.abort(error);
    await activeReader?.cancel(error).catch(() => {});
    activeReader?.releaseLock();
    stop();
    throw error;
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        abortController.signal.throwIfAborted();
        while (index < parts.length) {
          const part = parts[index]!;
          if (part.kind === 'bytes') {
            controller.enqueue(decode(part.base64).subarray(part.start, part.end + 1));
            index++;
            return;
          }
          if (part.kind === 'zeros') {
            const count = Math.min(part.size, 64 * 1024);
            controller.enqueue(new Uint8Array(count));
            part.size -= count;
            if (part.size === 0) index++;
            return;
          }
          if (activePart !== index) await getSource(part, index);
          const value = await activeReader!.read();
          abortController.signal.throwIfAborted();
          if (value.done) {
            activeReader!.releaseLock();
            activeReader = undefined;
            if (activeRemaining !== 0) throw new AudioTagError('temporary', 'The source audio stream ended early.');
            index++;
            continue;
          }
          activeRemaining -= value.value.length;
          if (activeRemaining < 0) throw new AudioTagError('content_changed', 'The source returned bytes outside the requested audio range.');
          controller.enqueue(value.value);
          return;
        }
        finished = true;
        stop();
        controller.close();
      } catch (error) {
        abortController.abort(error);
        await activeReader?.cancel(error).catch(() => {});
        activeReader?.releaseLock();
        activeReader = undefined;
        finished = true;
        stop();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      abortController.abort(reason);
      await activeReader?.cancel(reason).catch(() => {});
      activeReader?.releaseLock();
      activeReader = undefined;
      stop();
    },
  }, { highWaterMark: 0 });
  return { content: { ...plan.content }, servedRange: range ? { ...range } : null, body };
}
