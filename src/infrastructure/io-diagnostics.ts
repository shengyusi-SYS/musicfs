import { getLogger, withContext } from '@logtape/logtape';
import { errorFields } from './logging';
import type { Sources } from '../core/sources';
import type { Outcome } from '@musicfs/plugin-api';

function deadlineExceeded(signal?: AbortSignal | null): boolean {
  const reason: unknown = signal?.reason;
  return signal?.aborted === true && typeof reason === 'object' && reason !== null && 'name' in reason && reason.name === 'TimeoutError';
}

/** Add source ownership at the host seam without coupling the source domain to a logger. */
export function observeSources(sources: Sources): Sources {
  const logger = getLogger(['musicfs', 'io', 'source']);
  const run = <T>(instanceId: string, sourceOperation: string, signal: AbortSignal, work: () => Promise<Outcome<T>>) =>
    withContext({ instanceId, sourceOperation }, async () => {
      const started = performance.now();
      try {
        const result = await work();
        const fields = { elapsedMs: Math.round(performance.now() - started),
          ...(!result.ok ? { sourceFaultKind: result.error.kind, retryAfterSeconds: result.error.retryAfterSeconds } : {}) };
        if (!result.ok && !['not_found', 'content_changed', 'not_supported'].includes(result.error.kind)) logger.warning('Source returned a fault', fields);
        else logger.debug('Source operation completed', fields);
        return result;
      } catch (error) {
        const fields = { elapsedMs: Math.round(performance.now() - started), timedOut: deadlineExceeded(signal), ...errorFields(error) };
        if (signal.aborted && !deadlineExceeded(signal)) logger.debug('Source operation cancelled', fields);
        else logger.warning('Source operation threw', fields);
        throw error;
      }
    });
  return { ...sources,
    roots: (id, signal, ...args) => run(id, 'roots', signal, () => sources.roots(id, signal, ...args)),
    list: (id, directory, signal, ...args) => run(id, 'list', signal, () => sources.list(id, directory, signal, ...args)),
    stat: (id, file, signal) => run(id, 'stat', signal, () => sources.stat(id, file, signal)),
    open: (id, file, range, signal) => run(id, 'open', signal, () => sources.open(id, file, range, signal))
  };
}

/** Observe connection setup without reading bodies or copying request data into logs. */
export function observeFetch(fetcher: typeof fetch, peer: 'source' | 'cache' | 'rclone') {
  const request = fetcher.bind(globalThis);
  const logger = getLogger(['musicfs', 'io', peer]);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = performance.now(); const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    try {
      const response = await request(input, init);
      const fields = { method, status: response.status, elapsedMs: Math.round(performance.now() - started) };
      if (response.status >= 400 && response.status !== 404) logger.warning('Upstream response failed', fields);
      else logger.debug('Upstream response ready', fields);
      return response;
    } catch (error) {
      const fields = { method, elapsedMs: Math.round(performance.now() - started), timedOut: deadlineExceeded(signal), ...errorFields(error) };
      if (signal?.aborted && !deadlineExceeded(signal)) logger.debug('Upstream request cancelled', fields);
      else logger.warning('Upstream connection failed', fields);
      throw error;
    }
  }) as typeof fetch;
}

/** One observation at EOF/error/cancellation, never one per audio chunk. HWM 0 preserves backpressure. */
export function observeAudio(body: ReadableStream<Uint8Array>, fields: { requestId: string; expectedBytes: number; ranged: boolean;
  contentId?: string; rangeStart?: number; rangeEnd?: number }, signal: AbortSignal) {
  const logger = getLogger(['musicfs', 'io', 'dav']).with(fields);
  const reader = body.getReader(); const started = performance.now(); let lastByteAt = started; let bytes = 0; let finished = false;
  const finish = (event: 'completed' | 'failed' | 'cancelled', error?: unknown, cancellation?: string) => {
    if (finished) return; finished = true;
    const details = { ioStage: 'body', bytes, elapsedMs: Math.round(performance.now() - started),
      timedOut: deadlineExceeded(signal),
      idleMs: Math.round(performance.now() - lastByteAt),
      ...(event === 'failed' ? { failureKind: error ? 'stream_error' : 'unexpected_eof' } : {}),
      ...(cancellation ? { cancellation } : {}), ...(error ? errorFields(error) : {}) };
    if (event === 'failed') logger.warning('Audio stream failed', details);
    else logger.debug(event === 'completed' ? 'Audio stream completed' : 'Audio stream cancelled', details);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          const cancelled = signal.aborted && !deadlineExceeded(signal);
          finish(cancelled ? 'cancelled' : deadlineExceeded(signal) || bytes !== fields.expectedBytes ? 'failed' : 'completed',
            deadlineExceeded(signal) ? signal.reason : undefined, cancelled ? 'request_aborted' : undefined);
          reader.releaseLock(); controller.close(); return;
        }
        bytes += next.value.byteLength; lastByteAt = performance.now(); controller.enqueue(next.value);
      } catch (error) {
        const cancelled = signal.aborted && !deadlineExceeded(signal);
        finish(cancelled ? 'cancelled' : 'failed', error, cancelled ? 'request_aborted' : undefined); controller.error(error);
      }
    },
    async cancel(reason) {
      finish(deadlineExceeded(signal) ? 'failed' : 'cancelled', deadlineExceeded(signal) ? signal.reason : undefined,
        deadlineExceeded(signal) ? undefined : signal.aborted ? 'request_aborted' : 'consumer_cancelled');
      await reader.cancel(reason);
    }
  }, { highWaterMark: 0 });
}
