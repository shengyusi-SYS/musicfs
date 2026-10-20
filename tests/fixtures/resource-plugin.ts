import type { FileInfo, Json, SourcePlugin } from '@musicfs/plugin-api';

const settings = (value: Json) => value as { upstream: string; size: number };
const info = (size: number): FileInfo => ({ contentId: `resource-fixture-${size}`, size, mediaType: 'application/octet-stream' });

/** Synthetic bytes for resource measurement; never a music-platform sample. */
const plugin: SourcePlugin = {
  configuration: { schema: { type: 'object', additionalProperties: false, required: ['upstream', 'size'], properties: {
    upstream: { type: 'string', format: 'uri' }, size: { type: 'integer', minimum: 1 }
  } } },
  async validateConfig(_ctx, config) {
    const value = settings(config);
    return value && typeof value.upstream === 'string' && Number.isSafeInteger(value.size) && value.size > 0
      ? { ok: true, value: config } : { ok: false, error: { kind: 'invalid_config', message: 'Invalid resource fixture configuration' } };
  },
  async roots() { return { ok: true, value: { items: [{ sourceId: 'files', name: 'Files', directoryRef: '/' }] } }; },
  async list(ctx, _directory, cursor) {
    const config = settings(ctx.config); const url = new URL('/catalog', config.upstream);
    url.searchParams.set('offset', cursor ?? '0'); url.searchParams.set('size', String(config.size));
    const response = await ctx.fetch(url, { signal: ctx.signal });
    if (!response.ok) throw new Error('Resource fixture catalog failed');
    return { ok: true, value: await response.json() };
  },
  async stat(ctx) { return { ok: true, value: info(settings(ctx.config).size) }; },
  async open(ctx, _file, request) {
    const config = settings(ctx.config);
    const response = await ctx.fetch(new URL(`/bytes/${config.size}`, config.upstream), { signal: ctx.signal,
      headers: request.range ? { Range: `bytes=${request.range.start}-${request.range.end}` } : {} });
    if (!response.ok || !response.body) throw new Error('Resource fixture stream failed');
    return { ok: true, value: { content: info(config.size), body: response.body, servedRange: response.status === 206 ? request.range ?? null : null } };
  }
};
export default plugin;
