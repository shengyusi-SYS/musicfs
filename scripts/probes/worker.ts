import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { buildSample } from '../build-sample';

const archive = await buildSample();
const digest = new Bun.CryptoHasher('sha256').update(archive).digest('hex');
await mkdir('dist/p0', { recursive: true });
const build = await Bun.build({ entrypoints: ['tests/probes/local-worker.ts'], target: 'browser', format: 'esm', outdir: 'dist/p0', naming: 'local-worker.mjs' });
if (!build.success) throw new AggregateError(build.logs, 'Worker probe build failed');
const directory = await mkdtemp(join(tmpdir(), 'musicfs-worker-'));
const options = {
  modules: [{ type: 'ESModule' as const, path: resolve('dist/p0/local-worker.mjs') }], compatibilityDate: '2026-07-30',
  d1Databases: { DB: 'musicfs-p0' }, d1Persist: directory,
  bindings: { PLUGIN_REVISION: digest }, log: new Log(LogLevel.ERROR)
};
let mf: Miniflare | undefined;
try {
  mf = new Miniflare(options);
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()).replace(/^\s*--.*$/gm, '').replaceAll('\n', ' '));
  }
  const parsed = await mf.dispatchFetch('http://probe/archive', { method: 'POST', body: new Uint8Array(archive) });
  assert.equal(parsed.status, 200);
  assert.deepEqual(await parsed.json(), { digest, id: 'org.musicfs.sample' });
  for (const label of ['甲', '乙']) {
    const response = await mf.dispatchFetch('http://probe/create', { method: 'POST', body: JSON.stringify({ label }), headers: { 'Content-Type': 'application/json' } });
    const result = await response.json() as { ok: boolean }; assert(result.ok);
  }
  const invalid = await mf.dispatchFetch('http://probe/create', { method: 'POST', body: JSON.stringify({ label: '' }), headers: { 'Content-Type': 'application/json' } });
  assert.equal((await invalid.json() as { ok: boolean }).ok, false);
  let rows = await (await mf.dispatchFetch('http://probe/instances')).json() as { id: string; config: { label: string } }[];
  assert.equal(rows.length, 2); assert(rows[0]);
  const bytes = await mf.dispatchFetch(`http://probe/bytes/${rows[0].id}`); assert.equal(await bytes.text(), 'RIFF');
  const fences = await (await mf.dispatchFetch(`http://probe/fences/${rows[0].id}`, { method: 'POST' })).json();
  assert.deepEqual(fences, { first: true, oldState: false, configured: true, oldEpoch: false, removed: false, retained: 2, refusedUnknownRevision: true });
  await mf.dispose(); mf = new Miniflare(options);
  rows = await (await mf.dispatchFetch('http://probe/instances')).json() as typeof rows;
  assert.deepEqual(rows.map(row => row.config.label), ['更新', '乙']); assert(rows[0]);
  const restarted = await mf.dispatchFetch(`http://probe/bytes/${rows[0].id}`); assert.equal(await restarted.text(), 'RIFF');
  console.log(JSON.stringify({ runtime: 'local workerd', archive: 'zip.js native', validation: 'Ajv standalone', instances: 2, d1Restart: true, fences }));
  console.log('PASS: local Worker engine parsed the prebuilt ZIP, ran generated validation and plugin streams, and preserved fenced D1 state across restarts. Cloud deployment is not tested.');
} finally { await mf?.dispose(); await rm(directory, { recursive: true, force: true }); }
