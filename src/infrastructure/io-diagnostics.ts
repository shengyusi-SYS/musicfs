import { getLogger, withContext } from '@logtape/logtape';
import { errorFields } from './logging';
import type { Sources } from '../core/sources';

/** Add source ownership at the host seam without coupling the source domain to a logger. */
export function observeSources(sources: Sources): Sources {
  const run = <T>(instanceId: string, sourceOperation: string, work: () => T) => withContext({ instanceId, sourceOperation }, work);
  return { ...sources,
    roots: (id, ...args) => run(id, 'roots', () => sources.roots(id, ...args)),
    list: (id, ...args) => run(id, 'list', () => sources.list(id, ...args)),
    stat: (id, ...args) => run(id, 'stat', () => sources.stat(id, ...args)),
    open: (id, ...args) => run(id, 'open', () => sources.open(id, ...args))
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
      const fields = { method, elapsedMs: Math.round(performance.now() - started), ...errorFields(error) };
      if (signal?.aborted) logger.debug('Upstream request cancelled', fields);
      else logger.warning('Upstream connection failed', fields);
      throw error;
    }
  }) as typeof fetch;
}

/** One observation at EOF/error/cancellation, never one per audio chunk. HWM 0 preserves backpressure. */
export function observeAudio(body: ReadableStream<Uint8Array>, fields: { requestId: string; expectedBytes: number; ranged: boolean }, signal: AbortSignal) {
  const logger = getLogger(['musicfs', 'io', 'dav']).with(fields);
  const reader = body.getReader(); const started = performance.now(); let bytes = 0; let finished = false;
  const finish = (event: 'completed' | 'failed' | 'cancelled', error?: unknown) => {
    if (finished) return; finished = true;
    const details = { bytes, elapsedMs: Math.round(performance.now() - started), ...(error ? errorFields(error) : {}) };
    if (event === 'failed') logger.warning('Audio stream failed', details);
    else logger.debug(event === 'completed' ? 'Audio stream completed' : 'Audio stream cancelled', details);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { finish(signal.aborted ? 'cancelled' : bytes === fields.expectedBytes ? 'completed' : 'failed'); reader.releaseLock(); controller.close(); return; }
        bytes += next.value.byteLength; controller.enqueue(next.value);
      } catch (error) { finish(signal.aborted ? 'cancelled' : 'failed', error); controller.error(error); }
    },
    async cancel(reason) { finish('cancelled'); await reader.cancel(reason); }
  }, { highWaterMark: 0 });
}
