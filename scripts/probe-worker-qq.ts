import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { Database } from 'bun:sqlite';
import { buildQq } from './build-qq';
import { completeRefresh, publishedDirectory, requestReady } from './helpers/refresh-http';

await buildQq(); await mkdir('dist/p0/qq', { recursive: true });
const build = await Bun.build({ entrypoints: ['tests/probes/worker-qq.ts'], target: 'browser', format: 'esm', outdir: 'dist/p0/qq', naming: 'worker.mjs',
  plugins: [{ name: 'packed-qq-artifact', setup(builder) { builder.onResolve({ filter: /^musicfs-qq-artifact$/ }, () => ({ path: resolve('dist/plugins/org.musicfs.qq/index.mjs') })); } }] });
if (!build.success) throw new AggregateError(build.logs, 'QQ Worker probe build failed');
const directory = await mkdtemp(join(tmpdir(), 'musicfs-worker-qq-'));
let renewalRequests = 0;
const credential = { musicid: '123', str_musicid: '123', musickey: 'fixture-old-key', loginType: 6,
  refresh_key: 'fixture-refresh-key', refresh_token: 'fixture-refresh-token', openid: 'fixture-openid', encryptUin: 'encrypted-123' };
const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
  const body = await request.json() as { req_0: { method: string } }; assert.equal(body.req_0.method, 'Login'); renewalRequests++;
  return Response.json({ code: 0, req_0: { code: 0, data: { ...credential, musickey: 'fixture-renewed-key',
    musickeyCreateTime: Math.floor(Date.now() / 1000), keyExpiresIn: 3 * 86_400 } } });
} });
const mf = new Miniflare({ modules: [{ type: 'ESModule', path: resolve('dist/p0/qq/worker.mjs') }], compatibilityDate: '2026-07-30', d1Databases: { DB: 'musicfs-qq-p0' }, d1Persist: directory,
  bindings: { RENEWAL_URL: upstream.url.href }, log: new Log(LogLevel.ERROR) });
try {
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()).replace(/^\s*--.*$/gm, '').replaceAll('\n', ' '));
  }
  const headers = { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' };
  const dispatch = (url: string, init?: Pick<RequestInit, 'method' | 'headers'>) => mf.dispatchFetch(url, { ...init, headers: Object.fromEntries(new Headers(init?.headers)) });
  const instanceIds: string[] = [];
  for (const name of ['QQ 甲', 'QQ 乙']) {
    const created = await mf.dispatchFetch('http://probe/api/instances', { method: 'POST', headers, body: JSON.stringify({ pluginId: 'org.musicfs.qq', name, config: {} }) });
    assert.equal(created.status, 201); const text = await created.text(); assert(!text.includes('secret')); assert(!text.includes('privateState'));
    instanceIds.push((JSON.parse(text) as { value: { id: string } }).value.id);
  }
  const rows = await db.prepare('SELECT private_state FROM instances ORDER BY rowid').all<{ private_state: string }>();
  assert.equal(rows.results.length, 2); const states = rows.results.map(row => JSON.parse(row.private_state) as { secret: string });
  assert.notEqual(states[0]!.secret, states[1]!.secret);
  const { createSealedSessionResolver, deriveAndroidDevice } = await import('../plugins/qq/generated-upstream.mjs');
  const secret = states[1]!.secret; const resolver = createSealedSessionResolver({ secrets: { current: secret } });
  const token = await resolver.issue({ credential, device: await deriveAndroidDevice(secret), expiresAt: Date.now() + 3_600_000 });
  await db.prepare('UPDATE instances SET private_state = ? WHERE id = ?').bind(JSON.stringify({ version: 2, secret, token,
    accountName: 'fixture', pending: null, renewAfter: 0 }), instanceIds[1]!).run();
  const before = await db.prepare('SELECT epoch, state_revision FROM instances WHERE id = ?').bind(instanceIds[1]!).first<{ epoch: number; state_revision: number }>();
  const responses = await Promise.all([0, 1].map(() => mf.dispatchFetch(`http://probe/probe/renewal/${instanceIds[1]}`)));
  for (const response of responses) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true }); }
  const after = await db.prepare('SELECT epoch, state_revision, private_state FROM instances WHERE id = ?').bind(instanceIds[1]!).first<{ epoch: number; state_revision: number; private_state: string }>();
  assert(before && after); const renewed = JSON.parse(after.private_state) as { token: string; renewAfter: number };
  assert.notEqual(renewed.token, token); assert(renewed.renewAfter > Date.now());
  assert.equal((await resolver.resolve(renewed.token))?.credential.musickey, 'fixture-renewed-key');
  assert.equal(after.epoch, before.epoch); assert.equal(after.state_revision, before.state_revision + 2); assert.equal(renewalRequests, 1);
  const restored = await mf.dispatchFetch(`http://probe/probe/renewal/${instanceIds[1]}`); assert.equal(restored.status, 200); await restored.body?.cancel();
  assert.equal(renewalRequests, 1);
  console.log(JSON.stringify({ runtime: 'local workerd', packedSdkRenewal: true, controlledUpstream: true,
    concurrentControllers: 2, renewalRequests, persistedTokenCrossRuntime: true, epochPreserved: true, realVendorRenewalTested: false }));
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const challengeId = 'fixture-confirmed'; const operationId = crypto.randomUUID();
  await db.prepare('UPDATE instances SET private_state = ?, authentication = ? WHERE id = ?').bind(
    JSON.stringify({ ...JSON.parse(after.private_state), pending: { id: challengeId, key: 'fixture-consumed-key', channel: 'qq',
      expiresAt, confirmed: true, qrImage: 'data:image/png;base64,AA==' } }),
    JSON.stringify({ operationId, revision: 0, stamp: { id: instanceIds[1], pluginId: 'org.musicfs.qq', epoch: after.epoch,
      pluginRevision: 'd'.repeat(64), pluginGeneration: 1 }, step: { kind: 'waiting', challengeId, expiresAt, message: 'Fixture approval confirmed' } }), instanceIds[1]!).run();
  const authenticated = await mf.dispatchFetch(`http://probe/api/instances/${instanceIds[1]}/authentication`, { method: 'POST', headers,
    body: JSON.stringify({ kind: 'poll', operationId, challengeId }) });
  assert.equal(authenticated.status, 200);
  assert.deepEqual(await authenticated.json(), { ok: true, value: { operationId, step: { kind: 'complete' } } });
  const completedState = await db.prepare('SELECT private_state FROM instances WHERE id = ?').bind(instanceIds[1]!).first<{ private_state: string }>();
  assert(completedState); assert.equal(JSON.parse(completedState.private_state).pending, null); assert.equal(JSON.parse(completedState.private_state).token, renewed.token);
  console.log(JSON.stringify({ runtime: 'local workerd', packedAuthenticationCompletion: true, formalManagementRoute: true,
    restoredConfirmedCredential: true, privateStatePreserved: true, realQrScanTested: false }));
  const { MUSICFS_QQ_TEST_STATE_DB, MUSICFS_QQ_TEST_INSTANCE_ID } = process.env;
  if (MUSICFS_QQ_TEST_STATE_DB || MUSICFS_QQ_TEST_INSTANCE_ID) {
    assert(MUSICFS_QQ_TEST_STATE_DB && MUSICFS_QQ_TEST_INSTANCE_ID, 'Set both real-session probe selectors');
    const desktop = new Database(MUSICFS_QQ_TEST_STATE_DB, { readonly: true });
    let row: { private_state: string } | null;
    try { row = desktop.query('SELECT private_state FROM instances WHERE id = ? AND plugin_id = ?').get(MUSICFS_QQ_TEST_INSTANCE_ID, 'org.musicfs.qq') as typeof row; }
    finally { desktop.close(); }
    assert(row && JSON.parse(row.private_state).token, 'The selected instance must already be authorized');
    await db.prepare('UPDATE instances SET private_state = ? WHERE id = ?').bind(row.private_state, instanceIds[0]!).run();
    const roots = await requestReady(dispatch, `http://probe/api/instances/${instanceIds[0]}/roots`, { headers });
    assert.equal(roots.status, 200); assert.equal((await roots.json() as unknown[]).length, 5);
    const daily = await mf.dispatchFetch(`http://probe/api/instances/${instanceIds[0]}/refresh`, { method: 'POST', headers, body: JSON.stringify({ directoryRef: 'daily' }) });
    await completeRefresh(dispatch, daily, 'http://probe', headers);
    const snapshot = await publishedDirectory(dispatch, 'http://probe', instanceIds[0]!, 'daily', headers);
    const collections: Record<string, number> = {};
    for (const directoryRef of ['created', 'favorites', 'recommended']) {
      const response = await mf.dispatchFetch(`http://probe/api/instances/${instanceIds[0]}/refresh`, { method: 'POST', headers, body: JSON.stringify({ directoryRef }) });
      await completeRefresh(dispatch, response, 'http://probe', headers);
      collections[directoryRef] = (await publishedDirectory(dispatch, 'http://probe', instanceIds[0]!, directoryRef, headers)).entries.length;
    }
    console.log(JSON.stringify({ runtime: 'local workerd', restoredRealSession: true, authenticatedProfile: true, dailyFiles: snapshot.entries.length,
      collections,
      workerQrLoginTested: false, cloudDeploymentTested: false }));
    const configured = await mf.dispatchFetch(`http://probe/api/instances/${instanceIds[0]}/config`, { method: 'PUT', headers,
      body: JSON.stringify({ config: { audio: { mode: 'multiple', qualities: ['128', 'm4a'], missingQuality: 'hide' } } }) });
    assert.equal(configured.status, 200); await configured.body?.cancel();
    const multiple = await mf.dispatchFetch(`http://probe/api/instances/${instanceIds[0]}/refresh`, { method: 'POST', headers, body: JSON.stringify({ directoryRef: 'daily' }) });
    await completeRefresh(dispatch, multiple, 'http://probe', headers);
    const content = await publishedDirectory(dispatch, 'http://probe', instanceIds[0]!, 'daily', headers);
    const statistics = content.status?.statistics; assert(statistics);
    assert.equal(statistics.files, content.entries.length); assert(Number.isSafeInteger(statistics.tracks));
    const status = await mf.dispatchFetch(`http://probe/api/instances/${instanceIds[0]}/directory-status?directoryRef=daily`, { headers });
    assert.equal(status.status, 200); assert.deepEqual((await status.json() as { statistics: Record<string, number> }).statistics, statistics);
    console.log(JSON.stringify({ runtime: 'local workerd', multipleQualitySnapshot: true, persistedD1Counters: statistics }));
  }
  console.log(JSON.stringify({ runtime: 'local workerd', sdk: '@yakult-green-tea/qq-music-api 3.3.3/serverless', packedBundle: true, nodeCompatibility: false, isolatedSecrets: true, standaloneValidation: true, realLoginTested: false }));
} finally { await mf.dispose(); await upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
