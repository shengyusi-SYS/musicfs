import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { Database } from 'bun:sqlite';
import { buildQq } from './build-qq';

await buildQq(); await mkdir('dist/p0/qq', { recursive: true });
const build = await Bun.build({ entrypoints: ['tests/probes/worker-qq.ts'], target: 'browser', format: 'esm', outdir: 'dist/p0/qq', naming: 'worker.mjs',
  plugins: [{ name: 'packed-qq-artifact', setup(builder) { builder.onResolve({ filter: /^musicfs-qq-artifact$/ }, () => ({ path: resolve('dist/plugins/org.musicfs.qq/index.mjs') })); } }] });
if (!build.success) throw new AggregateError(build.logs, 'QQ Worker probe build failed');
const directory = await mkdtemp(join(tmpdir(), 'musicfs-worker-qq-'));
const mf = new Miniflare({ modules: [{ type: 'ESModule', path: resolve('dist/p0/qq/worker.mjs') }], compatibilityDate: '2026-07-30', d1Databases: { DB: 'musicfs-qq-p0' }, d1Persist: directory, log: new Log(LogLevel.ERROR) });
try {
  const db = await mf.getD1Database('DB');
  for (const migration of ['0001', '0002', '0003']) await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${migration}.sql`).text()).replaceAll('\n', ' '));
  const headers = { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' };
  const instanceIds: string[] = [];
  for (const name of ['QQ 甲', 'QQ 乙']) {
    const created = await mf.dispatchFetch('http://probe/api/instances', { method: 'POST', headers, body: JSON.stringify({ pluginId: 'org.musicfs.qq', name, config: {} }) });
    assert.equal(created.status, 201); const text = await created.text(); assert(!text.includes('secret')); assert(!text.includes('privateState'));
    instanceIds.push((JSON.parse(text) as { value: { id: string } }).value.id);
  }
  const rows = await db.prepare('SELECT private_state FROM instances ORDER BY rowid').all<{ private_state: string }>();
  assert.equal(rows.results.length, 2); const states = rows.results.map(row => JSON.parse(row.private_state) as { secret: string });
  assert.notEqual(states[0]!.secret, states[1]!.secret);
  const { MUSICFS_QQ_TEST_STATE_DB, MUSICFS_QQ_TEST_INSTANCE_ID } = process.env;
  if (MUSICFS_QQ_TEST_STATE_DB || MUSICFS_QQ_TEST_INSTANCE_ID) {
    assert(MUSICFS_QQ_TEST_STATE_DB && MUSICFS_QQ_TEST_INSTANCE_ID, 'Set both real-session probe selectors');
    const desktop = new Database(MUSICFS_QQ_TEST_STATE_DB, { readonly: true });
    let row: { private_state: string } | null;
    try { row = desktop.query('SELECT private_state FROM instances WHERE id = ? AND plugin_id = ?').get(MUSICFS_QQ_TEST_INSTANCE_ID, 'org.musicfs.qq') as typeof row; }
    finally { desktop.close(); }
    assert(row && JSON.parse(row.private_state).token, 'The selected instance must already be authorized');
    await db.prepare('UPDATE instances SET private_state = ? WHERE id = ?').bind(row.private_state, instanceIds[0]!).run();
    const roots = await mf.dispatchFetch(`http://probe/api/instances/${instanceIds[0]}/roots`, { headers });
    assert.equal(roots.status, 200); assert.equal((await roots.json() as unknown[]).length, 5);
    const daily = await mf.dispatchFetch(`http://probe/api/instances/${instanceIds[0]}/refresh`, { method: 'POST', headers, body: JSON.stringify({ directoryRef: 'daily' }) });
    assert.equal(daily.status, 200); const snapshot = await daily.json() as { items: unknown[] };
    const collections: Record<string, number> = {};
    for (const directoryRef of ['created', 'favorites', 'recommended']) {
      const response = await mf.dispatchFetch(`http://probe/api/instances/${instanceIds[0]}/refresh`, { method: 'POST', headers, body: JSON.stringify({ directoryRef }) });
      assert.equal(response.status, 200); collections[directoryRef] = (await response.json() as { items: unknown[] }).items.length;
    }
    console.log(JSON.stringify({ runtime: 'local workerd', restoredRealSession: true, authenticatedProfile: true, dailyFiles: snapshot.items.length,
      collections,
      workerQrLoginTested: false, cloudDeploymentTested: false }));
    const configured = await mf.dispatchFetch(`http://probe/api/instances/${instanceIds[0]}/config`, { method: 'PUT', headers,
      body: JSON.stringify({ config: { audio: { mode: 'multiple', qualities: ['128', 'm4a'], missingQuality: 'hide' } } }) });
    assert.equal(configured.status, 200); await configured.body?.cancel();
    const multiple = await mf.dispatchFetch(`http://probe/api/instances/${instanceIds[0]}/refresh`, { method: 'POST', headers, body: JSON.stringify({ directoryRef: 'daily' }) });
    assert.equal(multiple.status, 200); const content = await multiple.json() as { items: unknown[]; statistics: Record<string, number> };
    assert.equal(content.statistics.files, content.items.length); assert(Number.isSafeInteger(content.statistics.tracks));
    const status = await mf.dispatchFetch(`http://probe/api/instances/${instanceIds[0]}/directory-status?directoryRef=daily`, { headers });
    assert.equal(status.status, 200); assert.deepEqual((await status.json() as { statistics: Record<string, number> }).statistics, content.statistics);
    console.log(JSON.stringify({ runtime: 'local workerd', multipleQualitySnapshot: true, persistedD1Counters: content.statistics }));
  }
  console.log(JSON.stringify({ runtime: 'local workerd', sdk: '@yakult-green-tea/qq-music-api 3.3.3/serverless', packedBundle: true, nodeCompatibility: false, isolatedSecrets: true, standaloneValidation: true, realLoginTested: false }));
} finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
