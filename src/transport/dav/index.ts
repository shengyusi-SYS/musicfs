import { Hono, type Context } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import parseRange from 'range-parser';
import { LibraryError, type FileView } from '../../core/library';
import { SourceError } from '../../core/sources';
import { parsePropfind, propfindResponse } from './xml';

export type ReadCredentials = { username: string; password: string };
export type DavOptions = { fixedLength?: (size: number) => TransformStream<Uint8Array, Uint8Array> };
const allow = 'OPTIONS, PROPFIND, GET, HEAD';

export function davStatus(error: unknown): 400 | 404 | 409 | 412 | 502 | 503 | 500 {
  if (error instanceof LibraryError) {
    if (error.code === 'not_found' || error.code === 'not_directory') return 404;
    if (error.code === 'invalid_layout') return 400;
    if (error.code === 'conflict') return 409;
    if (error.code === 'content_changed') return 412;
    if (error.code === 'stale_call' || error.code === 'source_failed') return 503;
    return 502;
  }
  return error instanceof SourceError ? 503 : 500;
}
function logicalPath(url: string): string {
  const encoded = new URL(url).pathname.slice('/dav'.length).split('/').filter(Boolean);
  try {
    const parts = encoded.map(decodeURIComponent);
    if (parts.some(part => part.includes('/') || part.includes('\\') || part === '.' || part === '..')) throw new Error('Invalid segment');
    return '/' + parts.join('/');
  } catch { throw new HTTPException(400, { message: 'Invalid export path encoding' }); }
}
const modifiedSeconds = (date: string) => Math.floor(Date.parse(date) / 1000) * 1000;

/** One read-only Fetch path shared by Bun and Workers; XML/Range mechanisms come from libraries. */
export function createDav(view: FileView, credentials: ReadCredentials, options: DavOptions = {}) {
  if (!credentials.username || credentials.username.includes(':') || !credentials.password) throw new Error('DAV credentials are required');
  const app = new Hono();
  const auth = basicAuth(credentials);
  const limit = bodyLimit({ maxSize: 64 * 1024 });
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    return c.text(`MusicFS request failed (${davStatus(error)})`, davStatus(error));
  });
  const handler = async (c: Context) => {
    const method = c.req.method;
    if (method === 'OPTIONS') return new Response(null, { headers: { Allow: allow, DAV: '1', 'Content-Length': '0' } });
    if (!['GET', 'HEAD', 'PROPFIND'].includes(method)) return new Response(null, { status: 405, headers: { Allow: allow } });
    const signal = c.req.raw.signal; const path = logicalPath(c.req.url);
    const description = await view.stat(path, signal);
    if (method === 'PROPFIND') {
      const depth = c.req.header('Depth') ?? 'infinity';
      if (depth === 'infinity') return new Response('<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>', { status: 403, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
      if (depth !== '0' && depth !== '1') throw new HTTPException(400, { message: 'Depth must be 0 or 1' });
      const request = parsePropfind(await c.req.text());
      const entries = description.kind === 'directory' && depth === '1' ? await view.list(path, signal) : [];
      const xml = await propfindResponse(description, entries, request, (entry) => view.stat(entry, signal), davStatus);
      return new Response(xml, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'private, no-cache' } });
    }
    if (description.kind !== 'file') return new Response(null, { status: 204 });
    const content = description.handle.content; const etag = `"${description.etag}"`;
    const headers = new Headers({ 'Content-Type': content.mediaType, 'Accept-Ranges': 'bytes', ETag: etag,
      'Last-Modified': new Date(description.modifiedAt).toUTCString(), 'Cache-Control': 'private, no-cache' });
    const ifMatch = c.req.header('If-Match');
    if (ifMatch && ifMatch !== '*' && !ifMatch.split(',').map(value => value.trim()).includes(etag)) return new Response(null, { status: 412, headers });
    const ifNoneMatch = c.req.header('If-None-Match');
    if (ifNoneMatch && (ifNoneMatch === '*' || ifNoneMatch.split(',').some(value => value.trim().replace(/^W\//, '') === etag))) return new Response(null, { status: 304, headers });
    if (!ifNoneMatch && c.req.header('If-Modified-Since') && Date.parse(c.req.header('If-Modified-Since')!) >= modifiedSeconds(description.modifiedAt)) return new Response(null, { status: 304, headers });
    let range: { start: number; end: number } | undefined;
    let header = method === 'GET' ? c.req.header('Range') : undefined;
    const ifRange = c.req.header('If-Range');
    if (ifRange && (ifRange.startsWith('"') ? ifRange !== etag : ifRange.startsWith('W/') || !(Date.parse(ifRange) >= modifiedSeconds(description.modifiedAt)))) header = undefined;
    if (header && /^bytes=/i.test(header) && !header.includes(',')) {
      // The library rejects oversized suffixes. Normalize this valid HTTP case before parsing.
      const suffix = /^bytes=-(\d+)$/i.exec(header);
      if (suffix?.[1] && content.size > 0 && BigInt(suffix[1]) > BigInt(content.size)) header = `bytes=0-${content.size - 1}`;
      const ranges = parseRange(content.size, header, { combine: true });
      if (ranges === -1) { headers.set('Content-Range', `bytes */${content.size}`); return new Response(null, { status: 416, headers }); }
      if (ranges === -2) throw new HTTPException(400, { message: 'Invalid Range header' });
      if (ranges.type.toLowerCase() === 'bytes' && ranges.length === 1) range = ranges[0];
    }
    const length = range ? range.end - range.start + 1 : content.size;
    headers.set('Content-Length', String(length));
    if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${content.size}`);
    if (method === 'HEAD') return new Response(null, { headers });
    const result = await view.open(description, range, signal);
    let body = result.body;
    if (options.fixedLength) {
      const fixed = options.fixedLength(length);
      // pipeTo propagates cancellation and errors to both ends; the response owns the pipeline lifetime.
      void body.pipeTo(fixed.writable, { signal }).catch(() => {});
      body = fixed.readable;
    }
    return new Response(body, { status: range ? 206 : 200, headers });
  };
  app.all('/dav', auth, limit, handler);
  app.all('/dav/*', auth, limit, handler);
  return app;
}
