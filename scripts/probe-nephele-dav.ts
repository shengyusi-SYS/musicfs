import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { buildSample } from './build-sample';
import manifest from '../plugins/sample/manifest.json';

const archive = await buildSample();
const revision = new Bun.CryptoHasher('sha256').update(archive).digest('hex');
await mkdir('dist/p0/nephele/dav', { recursive: true });
const build = await Bun.build({ entrypoints: ['tests/probes/worker-nephele.ts'], target: 'node', format: 'esm',
  external: ['cloudflare:node', 'cloudflare:workers'], outdir: 'dist/p0/nephele/dav', naming: 'worker.mjs',
  define: { 'import.meta.url': JSON.stringify('file:///bundle/dav/worker.mjs') } });
if (!build.success) throw new AggregateError(build.logs, 'DAV Worker probe build failed');
// Nephele reads its package metadata relative to its module. Preserve that asset using Worker VFS.
await Bun.write('dist/p0/nephele/package.json', await Bun.file('node_modules/nephele/package.json').text());
const directory = await mkdtemp(join(tmpdir(), 'musicfs-worker-dav-'));
const mf = new Miniflare({
  modulesRoot: resolve('dist/p0/nephele'),
  modules: [{ type: 'ESModule', path: resolve('dist/p0/nephele/dav/worker.mjs') }, { type: 'Text', path: resolve('dist/p0/nephele/package.json') }],
  compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', 'enable_nodejs_http_server_modules'],
  d1Databases: { DB: 'musicfs-dav-p0' }, d1Persist: directory,
  bindings: { PLUGIN_REVISION: revision }, log: new Log(LogLevel.ERROR)
});
try {
  const db = await mf.getD1Database('DB');
  for (const migration of ['0001', '0002', '0003']) await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${migration}.sql`).text()).replaceAll('\n', ' '));
  await db.prepare("INSERT INTO installations (id, manifest, revision, generation, status) VALUES (?, ?, ?, 1, 'active')")
    .bind(manifest.id, JSON.stringify(manifest), revision).run();
  await db.prepare('INSERT INTO instances (id, plugin_id, name, config, private_state, epoch, state_revision) VALUES (?, ?, ?, ?, ?, 1, 1)')
    .bind('worker-instance', manifest.id, '实例 & #', JSON.stringify({ label: '目录 & #' }), 'null').run();
  const auth = 'Basic ' + Buffer.from('reader:fixture-password').toString('base64');
  const file = 'http://probe/dav/' + ['实例 & #', '目录 & #', '440 Hz.wav'].map(encodeURIComponent).join('/');
  const listing = await mf.dispatchFetch('http://probe/dav/', { method: 'PROPFIND', headers: { Authorization: auth, Depth: '1' } });
  assert.equal(listing.status, 207); assert((await listing.text()).includes(encodeURIComponent('实例 & #')));
  const head = await mf.dispatchFetch(file, { method: 'HEAD', headers: { Authorization: auth } });
  assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), '16044');
  const full = await mf.dispatchFetch(file, { headers: { Authorization: auth } }); assert.equal(full.status, 200);
  const bytes = new Uint8Array(await full.arrayBuffer()); assert.equal(bytes.length, 16044);
  for (const [range, start, end] of [['bytes=0-3', 0, 3], ['bytes=1000-2024', 1000, 2024], ['bytes=-16', 16028, 16043], ['bytes=-999999', 0, 16043]] as const) {
    const response = await mf.dispatchFetch(file, { headers: { Authorization: auth, Range: range } });
    assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Length'), String(end - start + 1));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(start, end + 1));
  }
  const invalid = await mf.dispatchFetch(file, { headers: { Authorization: auth, Range: 'bytes=16044-' } });
  assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('Content-Range'), 'bytes */16044'); await invalid.body?.cancel();
  console.log(JSON.stringify({ runtime: 'local workerd', dav: 'Nephele public adapter', vfsAsset: 'package.json', proppfind: 207,
    headLength: 16044, ranges: 'first/middle/tail/oversized-suffix', actualBytes: true, d1Snapshots: true }));
} finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
