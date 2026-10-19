import nephele, { BadGatewayError, BadRequestError, ForbiddenError, MethodNotSupportedError, PreconditionFailedError,
  PropertyNotFoundError, ResourceNotFoundError, ServiceUnavailableError, UnauthorizedError,
  type Adapter, type AuthResponse, type Properties, type Resource } from 'nephele';
import ReadOnlyPlugin from '@nephele/plugin-read-only';
import { PassThrough, Readable, pipeline } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { LibraryError, type Description, type FileView, type ViewEntry } from '../../src/core/library';
import { SourceError } from '../../src/core/sources';

const allowed = ['OPTIONS', 'PROPFIND', 'GET', 'HEAD'];
export type ReadCredentials = { username: string; password: string };

function translate(error: unknown): never {
  if (error instanceof LibraryError) {
    if (error.code === 'not_found') throw new ResourceNotFoundError('Export path not found');
    if (error.code === 'content_changed') throw new PreconditionFailedError('Content changed');
    if (error.code === 'stale_call' || error.code === 'source_failed') throw new ServiceUnavailableError('Source is not ready');
    throw new BadGatewayError('Source returned invalid audio or directory data');
  }
  if (error instanceof SourceError) throw new ServiceUnavailableError('Source instance is not ready');
  throw error;
}
const guarded = async <T>(work: () => Promise<T>): Promise<T> => { try { return await work(); } catch (error) { return translate(error); } };
const readOnly = async (): Promise<never> => { throw new MethodNotSupportedError('MusicFS exports are read-only'); };

/** The Worker Node bridge must commit headers before Node begins piping audio. */
class HttpAudioStream extends PassThrough {
  override pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T {
    const target = destination as T & { flushHeaders?: () => void };
    target.flushHeaders?.();
    return super.pipe(destination, options);
  }
}

function makeProperties(resource: Resource, description: () => Promise<Description>): Properties {
  const all = async () => {
    const value = await description();
    return {
      displayname: value.name || 'MusicFS', resourcetype: value.kind === 'directory' ? { collection: {} } : {},
      creationdate: value.modifiedAt, getlastmodified: new Date(value.modifiedAt).toUTCString(), getetag: `"${value.etag}"`,
      ...(value.kind === 'file' ? { getcontentlength: String(value.handle.content.size), getcontenttype: value.handle.content.mediaType } : {})
    };
  };
  const get = async (name: string) => {
    const values = await all();
    if (!Object.hasOwn(values, name)) throw new PropertyNotFoundError('Property is not available');
    return Reflect.get(values, name) as string | object;
  };
  const list = async () => Object.keys(await all());
  return {
    resource, get, getByUser: get, getAll: all, getAllByUser: all,
    list, listByUser: list, listLive: list, listLiveByUser: list,
    listDead: async () => [], listDeadByUser: async () => [],
    set: readOnly, setByUser: readOnly, remove: readOnly, removeByUser: readOnly,
    runInstructions: readOnly, runInstructionsByUser: readOnly
  };
}

function createAdapter(view: FileView, signal: AbortSignal, response: AuthResponse): Adapter {
  function makeResource(entry: ViewEntry, baseUrl: URL, known?: Description): Resource {
    let pending = known ? Promise.resolve(known) : undefined;
    const description = () => pending ??= guarded(() => view.stat(entry.path, signal));
    const resource: Resource = {
      adapter, baseUrl,
      getCanonicalName: async () => entry.name,
      getCanonicalPath: async () => entry.path + (entry.kind === 'directory' && entry.path !== '/' ? '/' : ''),
      async getCanonicalUrl() {
        const url = new URL(baseUrl);
        const suffix = entry.path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
        url.pathname = baseUrl.pathname.replace(/\/?$/, '/') + suffix + (entry.kind === 'directory' && suffix ? '/' : '');
        return url;
      },
      isCollection: async () => entry.kind === 'directory',
      getEtag: async () => (await description()).etag,
      async getLength() {
        const value = await description(); const length = value.kind === 'file' ? value.handle.content.size : 0;
        response.locals.musicfsLength = length; return length;
      },
      getMediaType: async () => { const value = await description(); return value.kind === 'file' ? value.handle.content.mediaType : null; },
      getProperties: async () => makeProperties(resource, description),
      async getInternalMembers() {
        return (await guarded(() => view.list(entry.path, signal))).map(child => makeResource(child, baseUrl));
      },
      async getStream(range) {
        const value = await description(); if (value.kind !== 'file') throw new ForbiddenError('Directory has no audio stream');
        const result = await guarded(() => view.open(value, range, signal));
        response.setHeader('Content-Length', range ? range.end - range.start + 1 : result.content.size);
        // Bun's Node declarations add convenience methods that standard Web Streams do not expose in the type.
        const source = Readable.fromWeb(result.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
        const output = new HttpAudioStream();
        pipeline(source, output, () => {});
        return output;
      },
      getLocks: async () => [], getLocksByUser: async () => [],
      createLockForUser: readOnly, setStream: readOnly, create: readOnly,
      delete: readOnly, copy: readOnly, move: readOnly
    };
    return resource;
  }
  const adapter: Adapter = {
    getComplianceClasses: async () => [], getAllowedMethods: async () => [],
    getOptionsResponseCacheControl: async () => 'private, no-cache',
    isAuthorized: async (_url, method) => allowed.includes(method),
    async getResource(url, baseUrl) {
      const prefix = baseUrl.pathname.replace(/\/$/, '');
      const relative = url.pathname.slice(prefix.length);
      let parts: string[];
      try { parts = relative.split('/').filter(Boolean).map(decodeURIComponent); }
      catch { throw new BadRequestError('Invalid export path encoding'); }
      if (parts.some(part => part.includes('/') || part.includes('\\') || part === '.' || part === '..')) throw new ResourceNotFoundError('Invalid export path');
      const value = await guarded(() => view.stat('/' + parts.join('/'), signal));
      return makeResource(value, baseUrl, value);
    },
    newResource: readOnly, newCollection: readOnly,
    getMethod() { throw new MethodNotSupportedError('Unsupported method'); }
  };
  return adapter;
}

/** All Nephele/Node types and protocol hooks stay inside this Adapter. */
export function createDav(view: FileView, credentials: ReadCredentials) {
  if (!credentials.username || credentials.username.includes(':') || !credentials.password) throw new Error('DAV credentials are required');
  const expected = Buffer.from('Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64'));
  return nephele({
    adapter: async (request, response) => {
      const abort = new AbortController();
      let finished = false;
      response.once('finish', () => { finished = true; });
      request.once('aborted', () => abort.abort(new Error('DAV request aborted')));
      response.once('close', () => { if (!finished) abort.abort(new Error('DAV client disconnected')); });
      const adapter = createAdapter(view, abort.signal, response);
      return { '/': adapter, '/dav/': adapter };
    },
    authenticator: {
      async authenticate(request, response) {
        const actual = Buffer.from((request.get('Authorization') ?? '').replace(/^basic /i, 'Basic '));
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          response.setHeader('WWW-Authenticate', 'Basic realm="MusicFS", charset="UTF-8"');
          throw new UnauthorizedError('DAV credentials are required');
        }
        return { username: credentials.username };
      },
      async cleanAuthentication() {}
    },
    plugins: [new ReadOnlyPlugin(), {
      async afterAuth(request, response) {
        if (!allowed.includes(request.method)) { response.setHeader('Allow', allowed.join(', ')); response.status(405).end(); return false; }
      },
      async beforeOptions(_request, _response, data) { data.allowedMethods.splice(0, data.allowedMethods.length, ...allowed); },
      async beforeGet(request, _response, { resource }) {
        const range = request.get('Range');
        if (!range) return;
        // RFC permits ignoring unsupported units and multipart requests. This export serves single ranges.
        if (!/^bytes=/i.test(range) || range.includes(',')) { delete request.headers.range; return; }
        const suffix = /^bytes=-(\d+)$/i.exec(range);
        if (suffix?.[1]) {
          const size = await resource.getLength();
          // range-parser rejects a suffix larger than the representation; normalize this valid HTTP case.
          if (size > 0 && BigInt(suffix[1]) > BigInt(size)) request.headers.range = `bytes=0-${size - 1}`;
        }
      },
      async beforeHead(_request, response, { resource }) { response.setHeader('Content-Length', await resource.getLength()); }
    }]
  }, {
    compression: false,
    async errorHandler(code, _message, _request, response, error) {
      if (response.headersSent || response.destroyed) {
        if (code >= 400 && !response.destroyed) response.destroy(error ?? new Error('Audio response failed'));
        else if (!response.destroyed) response.end();
        return;
      }
      response.removeHeader('Content-Length'); response.removeHeader('Content-Range');
      if (code === 416 && Number.isSafeInteger(response.locals.musicfsLength)) response.setHeader('Content-Range', `bytes */${response.locals.musicfsLength}`);
      response.status(code);
      if (code < 400) { response.end(); return; }
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end(`MusicFS request failed (${code})`);
    }
  });
}
