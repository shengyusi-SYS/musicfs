import { Hono, type Context } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { version } from '../../../package.json';
import type { HostKind, Json, Outcome } from '@musicfs/plugin-api';
import type { Result, Connection, Status, PluginInstallation, SourceInstance, SourceConfiguration, Layout, ViewEntry, DirectoryListing, AuthenticationSession } from '../../contracts/management';
import type { PluginChange } from '../../contracts/plugin-changes';
import type { MountInput, MountManager } from '../../contracts/mounts';
import type { RefreshView } from '../../contracts/refreshes';
import { updateRuleInput } from '../../core/library/update-timing';
import type { UpdateRule, RefreshPolicy } from '../../contracts/refresh-policy';
import type { DavAccess } from '../../contracts/dav-access';
import { ExtensionError, type Extensions, type Installation } from '../../core/extensions';
import { SourceError, type Sources } from '../../core/sources';
import { LibraryError, PendingRefreshError, type Library } from '../../core/library';
import { inspectPackage } from '../../infrastructure/archives';

const name = z.string().trim().min(1).max(120);
const instanceInput = z.object({ pluginId: z.string().min(1), name, config: z.json() }).strict();
const configInput = z.object({ config: z.json() }).strict();
const davCredentialsInput = z.object({
  username: z.string().trim().min(1).max(128).regex(/^[^:\u0000-\u001f\u007f]+$/),
  password: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/)
}).strict();
const refreshPolicyInput = z.object({ intervalMinutes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  .refine(value => value === 0 || value >= 15) }).strict();
const layoutInput = z.object({ expectedRevision: z.number().int().nonnegative(), nodes: z.json() }).strict();
const refreshInput = z.union([
  z.object({ scope: z.literal('instance') }).strict(),
  z.object({ scope: z.literal('directory'), directoryRef: z.string(), recursive: z.boolean().optional() }).strict(),
  z.object({ scope: z.enum(['file-info', 'metadata']), directoryRef: z.string() }).strict(),
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
  host: HostKind; adminToken: string; sources: Sources; library: Library; extensions: Pick<Extensions, 'list'>;
  managementAuth?: import('hono').MiddlewareHandler;
  connection?: Connection;
  davAccess?: DavAccess;
  mounts?: MountManager;
  mountAction?: (id: string) => void;
  maxPackageBytes: number; install: (archive: Uint8Array, signal: AbortSignal) => Promise<Installation | PluginChange>;
  remove: (id: string, signal: AbortSignal) => Promise<PluginChange | void>;
  pluginChange?: (id: string) => Promise<PluginChange | null>;
}) {
  const { sources, library, extensions } = input;
  if (!input.adminToken) throw new Error('Management token is required');
  const app = new Hono();
  app.use('/api/*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff'); await next(); });
  app.use('/api/*', input.managementAuth ?? bearerAuth({ token: input.adminToken }), bodyLimit({ maxSize: input.maxPackageBytes }));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof z.ZodError) return c.json({ error: 'invalid_input', message: 'Invalid management input' }, 400);
    if (error instanceof ExtensionError) return c.json({ error: error.code, message: error.message }, error.code === 'host_not_configured' ? 503 : error.code === 'missing_plugin' ? 404 : error.code === 'revision_conflict' || error.code === 'change_in_progress' ? 409 : 422);
    if (error instanceof Error && error.name === 'MountError' && 'code' in error) return c.json({ error: error.code, message: error.message }, error.code === 'not_found' ? 404 : error.code === 'mount_busy' ? 409 : 422);
    if (error instanceof SourceError) return c.json({ error: error.code, message: error.message }, error.code === 'missing_instance' ? 404 : error.code === 'stale_call' || error.code === 'invalid_auth_action' ? 409 : 502);
    if (error instanceof PendingRefreshError) {
      c.header('Retry-After', '2'); c.header('X-MusicFS-Refresh', error.operationId);
      return c.json({ error: 'refresh_pending', message: error.message, operationId: error.operationId }, 503);
    }
    if (error instanceof LibraryError) return c.json({ error: error.code, message: error.message, ...(error.sourceFault ? { sourceError: error.sourceFault } : {}) }, error.code === 'not_found' ? 404 : error.code === 'invalid_layout' ? 400 : error.code === 'conflict' ? 409 : 503);
    return c.json({ error: 'internal_error', message: 'Management operation failed' }, 500);
  });
  // Never serialize Outcome.nextPrivateState into a management response.
  const result = <T>(outcome: Outcome<T>): Result<T> => outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error };
  app.get('/api/status', c => c.json({ host: input.host, version } satisfies Status));
  app.get('/api/connection', async c => input.davAccess ? c.json({ davPath: '/dav', ...await input.davAccess.get() })
    : input.connection ? c.json(input.connection) : c.json({ error: 'not_supported', message: 'Connection details are unavailable' }, 404));
  app.put('/api/connection', async c => {
    if (!input.davAccess) return c.json({ error: 'not_supported', message: 'Connection settings are unavailable' }, 404);
    const value = davCredentialsInput.safeParse(await json(c));
    if (!value.success) return c.json({ error: 'invalid_credentials', message: '请填写用户名和密码；用户名不能包含冒号，内容不能包含换行等控制字符。' }, 422);
    await input.davAccess.save(value.data);
    return c.json({ davPath: '/dav', ...value.data } satisfies Connection);
  });
  app.get('/api/plugins', async c => c.json((await extensions.list()) satisfies PluginInstallation[]));
  app.post('/api/plugins/inspect', async c => c.json(await inspectPackage(new Uint8Array(await c.req.arrayBuffer()), input.host, c.req.raw.signal)));
  app.post('/api/plugins/inspect-url', async c => {
    const { url } = urlInput.parse(await json(c));
    return c.json(await inspectPackage(await download(url, c.req.raw.signal, input.maxPackageBytes), input.host, c.req.raw.signal));
  });
  const installed = (c: Context, result: Installation | PluginChange) => c.json(result, 'operationId' in result ? 202 : 201);
  app.post('/api/plugins', async c => installed(c, await input.install(new Uint8Array(await c.req.arrayBuffer()), c.req.raw.signal)));
  app.post('/api/plugins/from-url', async c => {
    const { url } = urlInput.parse(await json(c));
    return installed(c, await input.install(await download(url, c.req.raw.signal, input.maxPackageBytes), c.req.raw.signal));
  });
  app.delete('/api/plugins/:id', async c => {
    const result = await input.remove(c.req.param('id'), c.req.raw.signal);
    return result ? c.json(result, 202) : c.body(null, 204);
  });
  app.get('/api/plugin-changes/:id', async c => {
    const result = await input.pluginChange?.(c.req.param('id'));
    return result ? c.json(result) : c.json({ error: 'not_found', message: 'Plugin change was not found' }, 404);
  });
  app.get('/api/mounts', async c => input.mounts ? c.json(await input.mounts.list()) : c.json({ error: 'not_supported', message: 'Mounts are available on a desktop host' }, 404));
  app.post('/api/mounts', async c => {
    if (!input.mounts) return c.json({ error: 'not_supported', message: 'Mounts are available on a desktop host' }, 404);
    return c.json(await input.mounts.mount(await json(c) as MountInput), 201);
  });
  app.post('/api/mounts/:id/mount', async c => {
    if (!input.mounts) return c.json({ error: 'not_supported', message: 'Mounts are available on a desktop host' }, 404);
    input.mountAction?.(c.req.param('id'));
    return c.json(await input.mounts.remount(c.req.param('id')));
  });
  app.post('/api/mounts/:id/unmount', async c => {
    if (!input.mounts) return c.json({ error: 'not_supported', message: 'Mounts are available on a desktop host' }, 404);
    input.mountAction?.(c.req.param('id'));
    return c.json(await input.mounts.unmount(c.req.param('id')));
  });
  app.delete('/api/mounts/:id', async c => {
    if (!input.mounts) return c.json({ error: 'not_supported', message: 'Mounts are available on a desktop host' }, 404);
    input.mountAction?.(c.req.param('id'));
    await input.mounts.remove(c.req.param('id'));
    return c.body(null, 204);
  });
  app.get('/api/mounts/:id/cache', async c => {
    if (!input.mounts) return c.json({ error: 'not_supported', message: 'Mounts are available on a desktop host' }, 404);
    return c.json(await input.mounts.cacheStatus(c.req.param('id')));
  });
  app.delete('/api/mounts/:id/cache', async c => {
    if (!input.mounts) return c.json({ error: 'not_supported', message: 'Mounts are available on a desktop host' }, 404);
    input.mountAction?.(c.req.param('id'));
    return c.json(await input.mounts.clearCache(c.req.param('id')));
  });
  app.put('/api/mounts/:id/cache', async c => {
    if (!input.mounts) return c.json({ error: 'not_supported', message: 'Mounts are available on a desktop host' }, 404);
    const settings = z.object({ directoryCacheSeconds: z.number().int().min(0).max(2_147_483_647),
      fileCacheMaxMiB: z.number().int().min(0).max(1_048_576).optional(),
      fileCacheMaxAgeHours: z.number().int().min(0).max(2_147_483).optional() }).strict().parse(await json(c));
    input.mountAction?.(c.req.param('id'));
    return c.json(await input.mounts.configureCache(c.req.param('id'), { directoryCacheSeconds: settings.directoryCacheSeconds,
      ...(settings.fileCacheMaxMiB === undefined ? {} : { fileCacheMaxMiB: settings.fileCacheMaxMiB }),
      ...(settings.fileCacheMaxAgeHours === undefined ? {} : { fileCacheMaxAgeHours: settings.fileCacheMaxAgeHours }) }));
  });
  app.put('/api/mounts/:id/name', async c => {
    if (!input.mounts) return c.json({ error: 'not_supported', message: 'Mounts are available on a desktop host' }, 404);
    const { name } = z.object({ name: z.string() }).strict().parse(await json(c));
    input.mountAction?.(c.req.param('id'));
    return c.json(await input.mounts.rename(c.req.param('id'), name));
  });
  app.put('/api/mounts/:id/auto-mount', async c => {
    if (!input.mounts) return c.json({ error: 'not_supported', message: 'Mounts are available on a desktop host' }, 404);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(await json(c));
    if (!enabled) input.mountAction?.(c.req.param('id'));
    return c.json(await input.mounts.configureAutoMount(c.req.param('id'), enabled));
  });
  app.post('/api/mounts/:id/cache/refresh', async c => {
    if (!input.mounts) return c.json({ error: 'not_supported', message: 'Mounts are available on a desktop host' }, 404);
    await input.mounts.refresh(c.req.param('id'));
    return c.body(null, 204);
  });
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
  app.delete('/api/instances/:id/session', async c => { await sources.logout(c.req.param('id'), c.req.raw.signal); return c.body(null, 204); });
  app.get('/api/instances/:id/authentication', async c => c.json((await sources.authentication(c.req.param('id'))) satisfies AuthenticationSession | null));
  app.post('/api/instances/:id/authentication', async c => {
    const action = authInput.parse(await json(c));
    const outcome = await sources.authenticate(c.req.param('id'), action, c.req.raw.signal);
    return c.json(result(outcome), outcome.ok ? 200 : 422);
  });
  app.get('/api/instances/:id/roots', async c => c.json(await library.contentSources(c.req.param('id'), c.req.raw.signal)));
  app.get('/api/update-rules', async c => c.json((await library.schedules.list()) satisfies UpdateRule[]));
  app.post('/api/update-rules', async c => c.json(await library.schedules.create(updateRuleInput.parse(await json(c))), 201));
  app.put('/api/update-rules/:id', async c => c.json(await library.schedules.update(c.req.param('id'), updateRuleInput.parse(await json(c)))));
  app.delete('/api/update-rules/:id', async c => { await library.schedules.remove(c.req.param('id')); return c.body(null, 204); });
  app.post('/api/update-rules/:id/run', async c => {
    const operation = await library.schedules.run(c.req.param('id'), c.req.raw.signal);
    c.header('X-MusicFS-Refresh', operation.operationId);
    return c.json(operation satisfies RefreshView, 202);
  });
  app.get('/api/instances/:id/refresh-policy', async c => c.json(
    (await library.schedules.get(c.req.param('id'), c.req.query('directoryRef'))) satisfies RefreshPolicy));
  app.put('/api/instances/:id/refresh-policy', async c => {
    const value = refreshPolicyInput.parse(await json(c));
    return c.json((await library.schedules.set(c.req.param('id'), value.intervalMinutes, c.req.query('directoryRef'))) satisfies RefreshPolicy);
  });
  app.get('/api/instances/:id/directory-status', async c => {
    const directoryRef = z.string().parse(c.req.query('directoryRef'));
    return c.json(await library.directoryStatus(c.req.param('id'), directoryRef));
  });
  app.get('/api/instances/:id/file-naming', async c => c.json(await library.naming.get(c.req.param('id'), c.req.query('directoryRef'))));
  app.put('/api/instances/:id/file-naming', async c => {
    const value = z.object({ revision: z.number().int().nonnegative(), policy: z.unknown() }).strict().parse(await json(c));
    return c.json(await library.naming.set(c.req.param('id'), c.req.query('directoryRef'), value.revision, value.policy));
  });
  app.post('/api/instances/:id/file-naming/preview', async c => {
    const value = z.object({ policy: z.unknown() }).strict().parse(await json(c));
    return c.json(await library.naming.preview(c.req.param('id'), c.req.query('directoryRef'), value.policy));
  });
  app.post('/api/instances/:id/refresh', async c => {
    const value = refreshInput.parse(await json(c));
    const operation = await library.refreshes.start(c.req.param('id'), 'scope' in value
      ? value.scope === 'instance' ? { kind: 'instance' } : { kind: value.scope, directoryRef: value.directoryRef, ...('recursive' in value && value.recursive ? { recursive: true } : {}) }
      : { kind: 'directory', ...(value.directoryRef === undefined ? {} : { directoryRef: value.directoryRef }) });
    c.header('X-MusicFS-Refresh', operation.operationId);
    return c.json(operation satisfies RefreshView, 202);
  });
  app.get('/api/instances/:id/refresh', async c => c.json(await library.refreshes.current(c.req.param('id'))));
  app.get('/api/refreshes/:id', async c => {
    const operation = await library.refreshes.get(c.req.param('id'));
    return operation ? c.json(operation satisfies RefreshView) : c.json({ error: 'not_found', message: 'Refresh operation was not found' }, 404);
  });
  app.post('/api/refreshes/:id/step', async c => {
    const operation = await library.refreshes.step(c.req.param('id'), c.req.raw.signal);
    return c.json(operation satisfies RefreshView);
  });
  app.delete('/api/refreshes/:id', async c => {
    const operation = await library.refreshes.cancel(c.req.param('id'));
    return operation ? c.json(operation satisfies RefreshView) : c.json({ error: 'not_found', message: 'Refresh operation was not found' }, 404);
  });
  app.get('/api/layout', async c => c.json((await library.layout()) satisfies Layout));
  app.get('/api/layout/default', async c => c.json(await library.defaultLayout(c.req.raw.signal)));
  app.put('/api/layout', async c => {
    const value = layoutInput.parse(await json(c)); return c.json(await library.saveLayout(value.expectedRevision, value.nodes));
  });
  app.get('/api/library', async c => c.json((await library.files.list(c.req.query('path') ?? '/', c.req.raw.signal)) satisfies ViewEntry[]));
  app.get('/api/library/directory', async c => c.json((await library.browseDirectory(c.req.query('path') ?? '/', c.req.raw.signal)) satisfies DirectoryListing));
  return app;
}
