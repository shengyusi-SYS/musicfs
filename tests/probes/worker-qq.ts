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

const app = new Hono<{ Bindings: { DB: D1Database } }>(); const manifest = parseManifest(rawManifest, 'worker'); const revision = 'd'.repeat(64);
app.all('/api/*', async c => {
  const store = createD1Store(c.env.DB);
  if (!await store.installation(manifest.id)) await store.activate(manifest, revision, null);
  const sources = createSources(store, createWorkerRegistry(store, [{ id: manifest.id, revision, module: plugin }]));
  return createManagementApi({ host: 'worker', adminToken: 'fixture-admin', sources, library: createLibrary(sources, store), extensions: createExtensions(store, async () => {}),
    maxPackageBytes: 100_000, install: async () => { throw new Error('Not part of the QQ Worker probe'); } }).fetch(c.req.raw);
});
export default app;
