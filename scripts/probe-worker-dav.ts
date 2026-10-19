import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { buildSample } from './build-sample';
import manifest from '../plugins/sample/manifest.json';
import { completeRefresh } from './helpers/refresh-http';

const archive = await buildSample();
const revision = new Bun.CryptoHasher('sha256').update(archive).digest('hex');
await mkdir('dist/p0/dav', { recursive: true });
const build = await Bun.build({ entrypoints: ['tests/probes/worker-dav.ts'], target: 'browser', format: 'esm',
  outdir: 'dist/p0/dav', naming: 'worker.mjs' });
if (!build.success) throw new AggregateError(build.logs, 'DAV Worker probe build failed');
const directory = await mkdtemp(join(tmpdir(), 'musicfs-worker-dav-'));
const mf = new Miniflare({
  modulesRoot: resolve('dist/p0'),
  modules: [{ type: 'ESModule', path: resolve('dist/p0/dav/worker.mjs') }],
  compatibilityDate: '2026-07-30',
  d1Databases: { DB: 'musicfs-dav-p0' }, d1Persist: directory,
  bindings: { PLUGIN_REVISION: revision }, log: new Log(LogLevel.ERROR)
});
try {
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()).replace(/^\s*--.*$/gm, '').replaceAll('\n', ' '));
  }
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
  const previous = await db.prepare("SELECT request_id FROM directory_snapshots WHERE instance_id = ? AND kind = 'directory'").bind('worker-instance').first<{ request_id: string }>();
  assert(previous);
  const refreshed = await mf.dispatchFetch('http://probe/api/instances/worker-instance/refresh', { method: 'POST',
    headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'instance' }) });
  const operation = await completeRefresh((url, init) => mf.dispatchFetch(url, { ...init, headers: Object.fromEntries(new Headers(init?.headers)) }), refreshed, 'http://probe', { Authorization: 'Bearer fixture-admin' });
  assert.equal(operation.refreshedDirectories, 1); assert.deepEqual(operation.failures, []);
  const current = await db.prepare("SELECT request_id FROM directory_snapshots WHERE instance_id = ? AND kind = 'directory'").bind('worker-instance').first<{ request_id: string }>();
  assert(current); assert.notEqual(current.request_id, previous.request_id);
  console.log(JSON.stringify({ runtime: 'local workerd', dav: 'shared Fetch adapter', propfind: 207,
    headLength: 16044, ranges: 'first/middle/tail/oversized-suffix', actualBytes: true, d1Snapshots: true, instanceRefresh: true }));
} finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
