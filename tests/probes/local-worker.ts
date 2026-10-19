import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1Store } from '../../src/infrastructure/persistence/d1';
import { createWorkerRegistry } from '../../src/hosts/worker/plugins';
import { createSources } from '../../src/core/sources';
import { readPackage } from '../../src/infrastructure/archives';
import { parseManifest } from '../../src/core/extensions';
import plugin from '../../plugins/sample';
import rawManifest from '../../plugins/sample/manifest.json';

type Bindings = { DB: D1Database; PLUGIN_REVISION: string };
const manifest = parseManifest(rawManifest, 'worker');
const app = new Hono<{ Bindings: Bindings }>();

// Developer-only probe: never included in the product's public routing table.
app.post('/archive', async c => {
  const prepared = await readPackage(new Uint8Array(await c.req.arrayBuffer()), 'worker', c.req.raw.signal);
  return c.json({ digest: prepared.digest, id: prepared.manifest.id });
});
app.post('/create', async c => {
  const store = createD1Store(c.env.DB);
  if (!await store.installation(manifest.id)) await store.activate(manifest, c.env.PLUGIN_REVISION, null);
  const registry = createWorkerRegistry(store, [{ id: manifest.id, revision: c.env.PLUGIN_REVISION, module: plugin }]);
  const sources = createSources(store, registry);
  const { label } = await c.req.json<{ label: string }>();
  return c.json(await sources.create(manifest.id, label, { label }, c.req.raw.signal));
});
app.get('/instances', async c => c.json(await createD1Store(c.env.DB).instances()));
app.get('/bytes/:id', async c => {
  const store = createD1Store(c.env.DB);
  const registry = createWorkerRegistry(store, [{ id: manifest.id, revision: c.env.PLUGIN_REVISION, module: plugin }]);
  const sources = createSources(store, registry);
  const stat = await sources.stat(c.req.param('id'), 'tone', c.req.raw.signal);
  if (!stat.ok) return c.json(stat, 500);
  const read = await sources.open(c.req.param('id'), 'tone', { expectedContentId: stat.value.contentId, range: { start: 0, end: 3 } }, c.req.raw.signal);
  if (!read.ok) return c.json(read, 500);
  return new Response(read.value.body, { headers: { 'Content-Type': stat.value.mediaType } });
});
app.post('/fences/:id', async c => {
  const store = createD1Store(c.env.DB);
  const id = c.req.param('id'); const snapshot = await store.capture(id);
  if (!snapshot) return c.json({ error: 'missing instance' }, 500);
  const first = await store.saveState(snapshot, { token: 'fixture' });
  const oldState = await store.saveState(snapshot, { token: 'stale' });
  const current = await store.capture(id); if (!current) throw new Error('Missing current snapshot');
  const configured = await store.configure(current, { label: '更新' }, null);
  const oldEpoch = await store.saveState(current, { token: 'wrong epoch' });
  const after = await store.capture(id); if (!after) throw new Error('Missing updated snapshot');
  await store.markMissing(manifest.id, after.pluginGeneration);
  const removed = await store.saveState(after, { token: 'removed' });
  const retained = (await store.instances()).length;
  const installation = await store.installation(manifest.id); if (!installation) throw new Error('Missing installation');
  await store.activate(manifest, c.env.PLUGIN_REVISION, installation.generation);
  const restored = await store.installation(manifest.id); if (!restored) throw new Error('Missing restored installation');
  await store.activate(manifest, 'f'.repeat(64), restored.generation);
  const oldRegistry = createWorkerRegistry(store, [{ id: manifest.id, revision: c.env.PLUGIN_REVISION, module: plugin }]);
  let refusedUnknownRevision = false;
  try { await oldRegistry.get(manifest.id); } catch { refusedUnknownRevision = true; }
  const newer = await store.installation(manifest.id); if (!newer) throw new Error('Missing new installation');
  await store.activate(manifest, c.env.PLUGIN_REVISION, newer.generation);
  return c.json({ first, oldState, configured, oldEpoch, removed, retained, refusedUnknownRevision });
});
export default app;
