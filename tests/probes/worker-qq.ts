import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import plugin from 'musicfs-qq-artifact';
import rawManifest from '../../plugins/qq/manifest.json';
import { createD1Store } from '../../src/infrastructure/persistence/d1';
import { createWorkerRegistry } from '../../src/hosts/worker/plugins';
import { createSources } from '../../src/core/sources';
import { createExtensions, parseManifest } from '../../src/core/extensions';
import { createLibrary } from '../../src/core/library';
import { createManagementApi } from '../../src/transport/http';

const app = new Hono<{ Bindings: { DB: D1Database; RENEWAL_URL: string } }>(); const manifest = parseManifest(rawManifest, 'worker'); const revision = 'd'.repeat(64);
app.get('/probe/authentication-cancellation', async c => {
  const controller = new AbortController(); let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let requests = 0; let fetchCancelled = false;
  const work = plugin.authenticate!({ instanceId: 'packed-auth-cancellation', config: { channel: 'wechat' }, privateState: null,
    signal: controller.signal, fetch: (async (input, init) => {
      const request = new Request(input, init); requests++;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.throwIfAborted();
        request.signal.addEventListener('abort', () => { fetchCancelled = true; reject(request.signal.reason); }, { once: true });
        began();
      });
    }) as typeof fetch }, { kind: 'start' });
  // Surface startup failures rather than awaiting a Fetch that the bundle never reached.
  void work.then(began, began);
  await started;
  if (!requests) {
    try { const outcome = await work; return c.json({ beforeFetch: true, outcome: outcome.ok ? 'completed' : outcome.error }, 500); }
    catch (error) { return c.json({ beforeFetch: true, message: error instanceof Error ? error.message : String(error) }, 500); }
  }
  controller.abort(new Error('packed-auth-cancelled'));
  let rejected = false;
  try { await work; } catch (error) { rejected = error instanceof Error && error.message === 'packed-auth-cancelled'; }
  return c.json({ requests, fetchCancelled, rejectedWithoutStateCandidate: rejected });
});
// Only this local probe redirects renewal to a controlled upstream. The packed
// plugin still performs SDK rotation; ordinary content does not use fake accounts.
app.get('/probe/renewal/:id', async c => {
  const store = createD1Store(c.env.DB);
  const module = { ...plugin, roots: async () => ({ ok: true as const, value: { items: [] } }),
    renewal: { needed: plugin.renewal!.needed, renew: (ctx: Parameters<NonNullable<typeof plugin.renewal>['renew']>[0]) =>
      plugin.renewal!.renew({ ...ctx, fetch: (_input, init) => fetch(c.env.RENEWAL_URL, init) }) } };
  const sources = createSources(store, createWorkerRegistry(store, [{ id: manifest.id, revision, module }]));
  const outcome = await sources.roots(c.req.param('id'), c.req.raw.signal);
  return c.json({ ok: outcome.ok }, outcome.ok ? 200 : 500);
});
app.all('/api/*', async c => {
  const store = createD1Store(c.env.DB);
  if (!await store.installation(manifest.id)) await store.activate(manifest, revision, null);
  const sources = createSources(store, createWorkerRegistry(store, [{ id: manifest.id, revision, module: plugin }]));
  const extensions = createExtensions(store, async () => {});
  return createManagementApi({ host: 'worker', adminToken: 'fixture-admin', sources, library: createLibrary(sources, store), extensions, remove: id => extensions.remove(id),
    maxPackageBytes: 100_000, install: async () => { throw new Error('Not part of the QQ Worker probe'); } }).fetch(c.req.raw);
});
export default app;
