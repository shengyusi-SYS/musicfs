import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { SourcePlugin } from '@musicfs/plugin-api';
import { createD1Store } from '../../src/infrastructure/persistence/d1';
import { createWorkerRegistry } from '../../src/hosts/worker/plugins';
import { createSources } from '../../src/core/sources';
import { createExtensions, parseManifest } from '../../src/core/extensions';
import { createLibrary } from '../../src/core/library';
import { createManagementApi } from '../../src/transport/http';
import fixture, { fixtureManifest } from '../fixtures/authentication-plugin';

type Bindings = { DB: D1Database; GATE_URL: string };
const manifest = parseManifest(fixtureManifest, 'worker'); const revision = 'c'.repeat(64);
const held = { id: '', started: false };
const pluginFor = (gateUrl: string): SourcePlugin => ({ ...fixture, authenticate: async (ctx, action) => {
  if (ctx.instanceId !== held.id || action.kind !== 'poll') return fixture.authenticate!(ctx, action);
  held.started = true;
  const upstream = await ctx.fetch(gateUrl, { signal: ctx.signal }); await upstream.text();
  return { ok: true, value: { kind: 'complete' }, nextPrivateState: { mustNotPersist: true } };
} });
const app = new Hono<{ Bindings: Bindings }>();
// These coordination routes belong only to this local probe and are never in product routing.
app.post('/probe/hold/:id', c => { held.id = c.req.param('id'); return c.json({ held: true }); });
app.get('/probe/ready', c => c.json({ ready: held.started }));
app.all('/api/*', async c => {
  const store = createD1Store(c.env.DB);
  if (!await store.installation(manifest.id)) await store.activate(manifest, revision, null);
  const sources = createSources(store, createWorkerRegistry(store, [{ id: manifest.id, revision, module: pluginFor(c.env.GATE_URL) }]));
  return createManagementApi({ host: 'worker', adminToken: 'fixture-admin', sources, library: createLibrary(sources, store), extensions: createExtensions(store, async () => {}),
    maxPackageBytes: 100_000, install: async () => { throw new Error('Not part of this probe'); } }).fetch(c.req.raw);
});
export default app;
