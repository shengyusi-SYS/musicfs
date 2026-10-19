import { Hono, type Context } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { HostKind, Json, Outcome } from '@musicfs/plugin-api';
import type { Result, Connection, Status, PluginInstallation, SourceInstance, SourceConfiguration, Layout, ViewEntry, AuthenticationSession } from '../../contracts/management';
import { ExtensionError, type Extensions, type Installation } from '../../core/extensions';
import { SourceError, type Sources } from '../../core/sources';
import { LibraryError, type Library } from '../../core/library';

const name = z.string().trim().min(1).max(120);
const instanceInput = z.object({ pluginId: z.string().min(1), name, config: z.json() }).strict();
const configInput = z.object({ config: z.json() }).strict();
const layoutInput = z.object({ expectedRevision: z.number().int().nonnegative(), nodes: z.json() }).strict();
const refreshInput = z.union([
  z.object({ scope: z.literal('instance') }).strict(),
  z.object({ directoryRef: z.string().optional() }).strict()
]);
const urlInput = z.object({ url: z.url() }).strict();
const authInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start') }).strict(),
  z.object({ kind: z.literal('cancel'), operationId: z.uuid() }).strict(),
  z.object({ kind: z.literal('poll'), operationId: z.uuid(), challengeId: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('submit'), operationId: z.uuid(), challengeId: z.string().min(1).max(4096), input: z.json() }).strict()
]);
async function json(c: Context): Promise<unknown> {
  try { return await c.req.json(); } catch { throw new HTTPException(400, { message: 'Invalid JSON body' }); }
}

async function download(url: string, signal: AbortSignal, maxSize: number): Promise<Uint8Array> {
  const location = new URL(url);
  if (!['https:', 'http:'].includes(location.protocol) || location.username || location.password) throw new HTTPException(400, { message: 'Use an HTTP(S) plugin release URL without embedded credentials' });
  const response = await fetch(location, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new HTTPException(502, { message: 'Plugin download failed' }); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > maxSize) throw new HTTPException(413, { message: 'Plugin package is too large' });
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function createManagementApi(input: {
  host: HostKind; adminToken: string; sources: Sources; library: Library; extensions: Extensions;
  connection?: Connection;
  maxPackageBytes: number; install: (archive: Uint8Array, signal: AbortSignal) => Promise<Installation>;
}) {
  const { sources, library, extensions } = input;
  if (!input.adminToken) throw new Error('Management token is required');
  const app = new Hono();
  app.use('/api/*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff'); await next(); });
  app.use('/api/*', bearerAuth({ token: input.adminToken }), bodyLimit({ maxSize: input.maxPackageBytes }));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof z.ZodError) return c.json({ error: 'invalid_input', message: 'Invalid management input' }, 400);
    if (error instanceof ExtensionError) return c.json({ error: error.code, message: error.message }, error.code === 'missing_plugin' ? 404 : error.code === 'revision_conflict' ? 409 : 422);
    if (error instanceof SourceError) return c.json({ error: error.code, message: error.message }, error.code === 'missing_instance' ? 404 : error.code === 'stale_call' || error.code === 'invalid_auth_action' ? 409 : 502);
    if (error instanceof LibraryError) return c.json({ error: error.code, message: error.message, ...(error.sourceFault ? { sourceError: error.sourceFault } : {}) }, error.code === 'not_found' ? 404 : error.code === 'invalid_layout' ? 400 : error.code === 'conflict' ? 409 : 503);
    return c.json({ error: 'internal_error', message: 'Management operation failed' }, 500);
  });
  // Never serialize Outcome.nextPrivateState into a management response.
  const result = <T>(outcome: Outcome<T>): Result<T> => outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error };
  app.get('/api/status', c => c.json({ host: input.host, version: '0.1.0-dev.0' } satisfies Status));
  app.get('/api/connection', c => input.connection ? c.json(input.connection) : c.json({ error: 'not_supported', message: 'Connection details are unavailable' }, 404));
  app.get('/api/plugins', async c => c.json((await extensions.list()) satisfies PluginInstallation[]));
  app.post('/api/plugins', async c => c.json(await input.install(new Uint8Array(await c.req.arrayBuffer()), c.req.raw.signal), 201));
  app.post('/api/plugins/from-url', async c => {
    const { url } = urlInput.parse(await json(c));
    return c.json(await input.install(await download(url, c.req.raw.signal, input.maxPackageBytes), c.req.raw.signal), 201);
  });
  app.delete('/api/plugins/:id', async c => { await extensions.remove(c.req.param('id')); return c.body(null, 204); });
  app.get('/api/plugins/:id/configuration', async c => c.json((await sources.configuration(c.req.param('id'))) satisfies SourceConfiguration));
  app.get('/api/instances', async c => c.json((await sources.instances()) satisfies SourceInstance[]));
  app.post('/api/instances', async c => {
    const value = instanceInput.parse(await json(c));
    const result = await sources.create(value.pluginId, value.name, value.config as Json, c.req.raw.signal);
    return c.json(result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error }, result.ok ? 201 : 422);
  });
  app.put('/api/instances/:id/config', async c => {
    const value = configInput.parse(await json(c));
    const configured = await sources.configure(c.req.param('id'), value.config as Json, c.req.raw.signal);
    return c.json(result(configured), configured.ok ? 200 : 422);
  });
  app.delete('/api/instances/:id', async c => { await sources.delete(c.req.param('id')); return c.body(null, 204); });
  app.get('/api/instances/:id/authentication', async c => c.json((await sources.authentication(c.req.param('id'))) satisfies AuthenticationSession | null));
  app.post('/api/instances/:id/authentication', async c => {
    const action = authInput.parse(await json(c));
    const outcome = await sources.authenticate(c.req.param('id'), action, c.req.raw.signal);
    return c.json(result(outcome), outcome.ok ? 200 : 422);
  });
  app.get('/api/instances/:id/roots', async c => c.json(await library.contentSources(c.req.param('id'), c.req.raw.signal)));
  app.get('/api/instances/:id/directory-status', async c => {
    const directoryRef = z.string().parse(c.req.query('directoryRef'));
    return c.json(await library.directoryStatus(c.req.param('id'), directoryRef));
  });
  app.post('/api/instances/:id/refresh', async c => {
    const value = refreshInput.parse(await json(c));
    return c.json('scope' in value ? await library.refreshInstance(c.req.param('id'), c.req.raw.signal)
      : await library.refresh(c.req.param('id'), value.directoryRef, c.req.raw.signal));
  });
  app.get('/api/layout', async c => c.json((await library.layout()) satisfies Layout));
  app.put('/api/layout', async c => {
    const value = layoutInput.parse(await json(c)); return c.json(await library.saveLayout(value.expectedRevision, value.nodes));
  });
  app.get('/api/library', async c => c.json((await library.files.list(c.req.query('path') ?? '/', c.req.raw.signal)) satisfies ViewEntry[]));
  return app;
}
