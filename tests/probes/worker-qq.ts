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
  return createManagementApi({ host: 'worker', adminToken: 'fixture-admin', sources, library: createLibrary(sources, store), extensions: createExtensions(store, async () => {}),
    maxPackageBytes: 100_000, install: async () => { throw new Error('Not part of the QQ Worker probe'); } }).fetch(c.req.raw);
});
export default app;
