import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, Log, LogLevel } from 'miniflare';
import type { AuthenticationSession } from '../../src/contracts/management';
import { buildSample } from '../build-sample';

await buildSample(); await mkdir('dist/p0/authentication', { recursive: true });
const build = await Bun.build({ entrypoints: ['tests/probes/worker-authentication.ts'], target: 'browser', format: 'esm', outdir: 'dist/p0/authentication', naming: 'worker.mjs' });
if (!build.success) throw new AggregateError(build.logs, 'Authentication Worker probe build failed');
const directory = await mkdtemp(join(tmpdir(), 'musicfs-worker-auth-'));
const release = Promise.withResolvers<void>();
const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async () => { await release.promise; return new Response('upstream fixture approved'); } });
const options = { modules: [{ type: 'ESModule' as const, path: resolve('dist/p0/authentication/worker.mjs') }], compatibilityDate: '2026-07-30',
  d1Databases: { DB: 'musicfs-authentication-p0' }, d1Persist: directory, bindings: { GATE_URL: upstream.url.href }, log: new Log(LogLevel.ERROR) };
let mf: Miniflare | undefined;
try {
  mf = new Miniflare(options); const db = await mf.getD1Database('DB');
  for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()).replace(/^\s*--.*$/gm, '').replaceAll('\n', ' '));
  }
  const call = (path: string, value?: unknown) => mf!.dispatchFetch('http://probe' + path, { headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { method: 'POST', body: JSON.stringify(value) }) });
  const create = async (mode: string) => { const response = await call('/api/instances', { pluginId: 'org.musicfs.test.authentication', name: '测试实例', config: { mode } }); assert.equal(response.status, 201); return (await response.json() as { value: { id: string } }).value.id; };
  const auth = async (id: string, action: unknown) => { const response = await call(`/api/instances/${id}/authentication`, action); assert.equal(response.status, 200); return (await response.json() as { value: AuthenticationSession }).value; };
  const first = await create('input'); const second = await create('qr'); const initial = await auth(first, { kind: 'start' });
  assert.equal(initial.step?.kind, 'input');
  const wrong = await call(`/api/instances/${first}/authentication`, { kind: 'submit', operationId: initial.operationId, challengeId: initial.step && 'challengeId' in initial.step ? initial.step.challengeId : '', input: { code: '000000' } }); assert.equal(wrong.status, 422);
  await mf.dispose(); mf = new Miniflare(options);
  const restored = await (await call(`/api/instances/${first}/authentication`)).json() as AuthenticationSession;
  assert.equal(restored.operationId, initial.operationId); assert.equal(restored.step?.kind, 'input'); assert.equal(restored.error?.kind, 'invalid_config');
  const completed = await auth(first, { kind: 'submit', operationId: restored.operationId, challengeId: restored.step && 'challengeId' in restored.step ? restored.step.challengeId : '', input: { code: '123456' } }); assert.equal(completed.step?.kind, 'complete');
  const roots = await call(`/api/instances/${first}/roots`); assert.equal(roots.status, 200);
  assert.equal(await (await call(`/api/instances/${second}/authentication`)).json(), null);
  const waiting = await auth(second, { kind: 'start' }); assert.equal(waiting.step?.kind, 'waiting');
  await call(`/probe/hold/${second}`, {});
  const poll = call(`/api/instances/${second}/authentication`, { kind: 'poll', operationId: waiting.operationId, challengeId: waiting.step && 'challengeId' in waiting.step ? waiting.step.challengeId : '' });
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) { ready = (await (await call('/probe/ready')).json() as { ready: boolean }).ready; if (!ready) await Bun.sleep(10); }
  assert(ready, 'held poll did not enter the plugin');
  const cancelled = await auth(second, { kind: 'cancel', operationId: waiting.operationId }); assert.equal(cancelled.step?.kind, 'cancelled');
  release.resolve(); assert.equal((await poll).status, 409);
  const currentDb = await mf.getD1Database('DB'); const rows = await currentDb.prepare('SELECT private_state FROM instances ORDER BY rowid').all<{ private_state: string }>();
  assert.deepEqual(JSON.parse(rows.results[0]!.private_state), { authorized: true, token: 'fixture-session-token' }); assert.equal(JSON.parse(rows.results[1]!.private_state), null);
  const logout = await mf.dispatchFetch(`http://probe/api/instances/${first}/session`, { method: 'DELETE', headers: { Authorization: 'Bearer fixture-admin' } });
  assert.equal(logout.status, 204);
  await mf.dispose(); mf = new Miniflare(options);
  assert.equal(await (await call(`/api/instances/${first}/authentication`)).json(), null);
  const unavailable = await call(`/api/instances/${first}/roots`); assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json() as { sourceError: { kind: string } }).sourceError.kind, 'needs_auth');
  const restarted = await auth(first, { kind: 'start' }); assert.equal(restarted.step?.kind, 'input');
  const relogged = await auth(first, { kind: 'submit', operationId: restarted.operationId,
    challengeId: restarted.step && 'challengeId' in restarted.step ? restarted.step.challengeId : '', input: { code: '123456' } });
  assert.equal(relogged.step?.kind, 'complete'); assert.equal((await call(`/api/instances/${first}/roots`)).status, 200);
  const other = await (await call(`/api/instances/${second}/authentication`)).json() as AuthenticationSession;
  assert.equal(other.operationId, cancelled.operationId); assert.equal(other.step?.kind, 'cancelled');
  console.log(JSON.stringify({ runtime: 'local workerd', api: 'formal management routes', d1AuthenticationRestart: true, instances: 2, inputFailureState: true, latePollAfterCancel: 409,
    logoutSurvivesRestart: true, reloginRestoresContent: true, otherInstancePreserved: true, privateStateLeaked: false }));
} finally { release.resolve(); await mf?.dispose(); await upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
