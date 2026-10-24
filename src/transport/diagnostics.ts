import { getLogger, withContext } from '@logtape/logtape';
import type { Context, MiddlewareHandler } from 'hono';
import { requestId } from 'hono/request-id';
import { errorFields } from '../infrastructure/logging';

const logger = getLogger(['musicfs', 'http']);
const assignRequestId = requestId({ headerName: 'X-MusicFS-Request-ID' });

function requestFields(c: Context) {
  const range = c.req.header('Range');
  return { requestId: c.get('requestId'), method: c.req.method, route: c.req.routePath,
    ...(typeof c.get('ioStage') === 'string' ? { ioStage: c.get('ioStage') } : {}),
    ...(range && range.length <= 96 && /^bytes=\d*-\d*$/.test(range) ? { range } : {}) };
}

export const requestDiagnostics: MiddlewareHandler = async (c, next) => {
  const started = performance.now();
  await assignRequestId(c, () => withContext({ requestId: c.get('requestId') }, next));
  getLogger(['musicfs', 'io', 'http']).debug('HTTP response ready', { requestId: c.get('requestId'), method: c.req.method,
    route: c.req.routePath, status: c.res.status, elapsedMs: Math.round(performance.now() - started) });
};

/** Log failures once, with a route pattern rather than filenames, queries, headers or bodies. */
export function reportRequestFailure(c: Context, error: unknown, status = 500): string {
  const requestId = c.get('requestId') ?? crypto.randomUUID();
  c.header('X-MusicFS-Request-ID', requestId);
  logger.error('HTTP operation failed', { ...requestFields(c), requestId, status, ...errorFields(error) });
  return requestId;
}

export function reportSourceFailure(c: Context, error: unknown, status: number) {
  getLogger(['musicfs', 'io', 'source']).warning('Source operation failed', {
    ...requestFields(c), status, ...errorFields(error)
  });
}

export function reportPendingRead(c: Context, error: Error) {
  getLogger(['musicfs', 'io', 'dav']).warning('DAV waiting for file preparation', {
    ...requestFields(c), status: 503, retryAfterSeconds: 2, ...errorFields(error)
  });
}
