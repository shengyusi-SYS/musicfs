import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Log, LogLevel, Miniflare } from 'miniflare';
import type { RefreshView } from '../src/contracts/refreshes';

type ProbeResponse = Awaited<ReturnType<Miniflare['dispatchFetch']>>;
const directory = await mkdtemp(join(tmpdir(), 'musicfs-worker-refresh-'));
let edition: 'seed' | 'large' = 'seed';
let upstreamRequests = 0;
const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
  assert.equal(new URL(request.url).pathname, '/page');
  upstreamRequests++;
  return new Response(edition, { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
} });
let mf: Miniflare | undefined;
const measurements: { path: string; sql: number; pages: number; roots: number; subrequests: number; backgroundTasks: number }[] = [];
try {
  const build = await Bun.build({ entrypoints: ['tests/probes/worker-refresh.ts'], target: 'browser', format: 'esm',
    outdir: directory, naming: 'worker.mjs' });
  if (!build.success) throw new AggregateError(build.logs, 'Refresh Worker probe build failed');
  const options = { modulesRoot: directory, modules: [{ type: 'ESModule' as const, path: resolve(directory, 'worker.mjs') }],
    compatibilityDate: '2026-07-30', d1Databases: { DB: 'musicfs-refresh-probe' }, d1Persist: join(directory, 'd1'),
    bindings: { PAGE_URL: new URL('/page', upstream.url).href }, log: new Log(LogLevel.ERROR) };
  mf = new Miniflare(options);
  let db = await mf.getD1Database('DB');
  for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()).replace(/^\s*--.*$/gm, '').replaceAll('\n', ' '));
  }
  const manifest = { formatVersion: 1, id: 'org.musicfs.test.refresh', name: 'Refresh probe fixture', version: '0.1.0',
    apiRange: '>=0.1.2 <0.2.0', hosts: { worker: 'index.mjs' }, configVersion: 1, stateVersion: 1, files: ['index.mjs', 'LICENSE.txt'] };
  await db.prepare("INSERT INTO installations (id, manifest, revision, generation, status) VALUES (?, ?, ?, 1, 'active')")
    .bind(manifest.id, JSON.stringify(manifest), 'e'.repeat(64)).run();

  const call = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', drainBackground = false) => {
    const before = upstreamRequests;
    const response = await mf!.dispatchFetch('http://probe' + path, { method,
      headers: { Authorization: method === 'PROPFIND' ? 'Basic ' + btoa('reader:fixture-password') : 'Bearer fixture-admin', 'Content-Type': 'application/json',
        ...(method === 'PROPFIND' ? { Depth: '1' } : {}),
        ...(drainBackground ? { 'X-Probe-WaitUntil': 'drain' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const count = (header: string) => {
      const value = response.headers.get(header); assert(value !== null, `Missing ${header} on ${path}`);
      const number = Number(value); assert(Number.isInteger(number) && number >= 0); return number;
    };
    const measured = { path, sql: count('X-Probe-D1-statements'), pages: count('X-Probe-plugin-pages'),
      roots: count('X-Probe-plugin-roots'), subrequests: count('X-Probe-subrequests'), backgroundTasks: count('X-Probe-background-tasks') };
    assert(measured.sql < 50, `${path} prepared ${measured.sql} SQL statements`);
    assert.equal(upstreamRequests - before, measured.subrequests, `${path}: real upstream request count`);
    if (!drainBackground) assert.equal(measured.backgroundTasks, 0);
    measurements.push(measured);
    return response;
  };
  const json = async <T>(response: ProbeResponse, expected = 200): Promise<T> => {
    assert.equal(response.status, expected, await response.clone().text()); return response.json() as Promise<T>;
  };
  const created = await json<{ ok: boolean; value: { id: string } }>(await call('/api/instances', {
    pluginId: manifest.id, name: 'Paged instance', config: {}
  }), 201);
  assert(created.ok); const instanceId = created.value.id;
  const base = `/api/instances/${instanceId}`;
  const start = async (directoryRef?: string) => {
    const view = await json<RefreshView>(await call(`${base}/refresh`, directoryRef === undefined ? {} : { directoryRef }), 202);
    assert.equal(view.status, 'queued'); assert.equal(measurements.at(-1)!.pages, 0); assert.equal(measurements.at(-1)!.roots, 0);
    return view;
  };
  // Produce the previous successful directory snapshot through the same formal routes.
  const roots = await start();
  assert.equal((await json<RefreshView>(await call(`/api/refreshes/${roots.operationId}/step`, {}))).status, 'completed');
  const seed = await start('large');
  assert.equal((await json<RefreshView>(await call(`/api/refreshes/${seed.operationId}/step`, {}))).status, 'completed');
  const listingPath = '/api/library?path=' + encodeURIComponent('/Paged instance/Large');
  const oldListing = await json<{ name: string }[]>(await call(listingPath));
  assert.deepEqual(oldListing.map(item => item.name), ['Old snapshot.mp3']);
  const snapshot = () => db.prepare("SELECT document, published_attempt_id FROM directory_snapshots WHERE instance_id = ? AND kind = 'directory' AND ref = 'large'")
    .bind(instanceId).first<{ document: string; published_attempt_id: string }>();
  const old = await snapshot(); assert(old); assert.equal(JSON.parse(old.document).statistics.files, 1);

  edition = 'large';
  const beforeLarge = upstreamRequests;
  let view = await start('large');
  assert.deepEqual(view.scope, { kind: 'directory', directoryRef: 'large' });
  const resource = `/api/refreshes/${view.operationId}`;
  const steps: { sql: number; pages: number; subrequests: number }[] = [];
  for (let page = 1; page <= 42; page++) {
    const status = await json<RefreshView>(await call(resource));
    assert.equal(status.current?.pages, page - 1); assert.equal(measurements.at(-1)!.pages, 0);
    assert.equal(measurements.at(-1)!.roots, 0); assert.equal(measurements.at(-1)!.subrequests, 0);
    view = await json<RefreshView>(await call(`${resource}/step`, {}));
    const measured = measurements.at(-1)!; steps.push(measured);
    assert.equal(measured.pages, 1); assert.equal(measured.roots, 0); assert.equal(measured.subrequests, 1);
    const entries = Math.min(page * 100, 4158);
    assert.equal(view.current?.pages, page); assert.equal(view.current?.entries, entries);
    assert.deepEqual(view.current?.statistics, { tracks: entries, files: entries });
    assert.equal(view.status, page === 42 ? 'completed' : 'running');
    assert.equal(view.failures.length, 0);
    const stored = await snapshot(); assert(stored);
    if (page < 42) {
      assert.equal(stored.published_attempt_id, old.published_attempt_id);
      assert.equal(stored.document, old.document);
      const listing = await json<{ name: string }[]>(await call(listingPath));
      assert.deepEqual(listing.map(item => item.name), ['Old snapshot.mp3']);
      assert.equal(measurements.at(-1)!.pages, 0); assert.equal(measurements.at(-1)!.subrequests, 0);
    } else {
      assert.notEqual(stored.published_attempt_id, old.published_attempt_id);
      assert.equal(JSON.parse(stored.document).statistics.files, 4158);
      assert.equal(JSON.parse(stored.document).items, undefined, 'Published header must not rewrite a cumulative entry array');
    }
    const candidate = await db.prepare(`SELECT COUNT(*) AS count FROM library_snapshot_entries WHERE attempt_id =
      (SELECT json_extract(document, '$.task.attemptId') FROM library_refresh_jobs WHERE operation_id = ?)`)
      .bind(view.operationId).first<{ count: number }>();
    assert.equal(candidate?.count, entries, 'Each independent request appends exactly its page');
    if (page === 21) {
      await mf.dispose(); mf = new Miniflare(options); db = await mf.getD1Database('DB');
      const restored = await json<RefreshView>(await call(resource));
      assert.equal(restored.operationId, view.operationId); assert.equal(restored.current?.pages, 21);
      assert.equal(restored.current?.entries, 2100); assert.equal(measurements.at(-1)!.pages, 0);
      assert.equal(measurements.at(-1)!.subrequests, 0); assert.equal((await snapshot())?.published_attempt_id, old.published_attempt_id);
    }
  }
  const largeRequests = upstreamRequests - beforeLarge;
  assert.equal(view.refreshedDirectories, 1); assert.equal(largeRequests, 42);
  const stored = await snapshot(); assert(stored);
  const rows = await db.prepare('SELECT ordinal, document FROM library_snapshot_entries WHERE attempt_id = ? ORDER BY ordinal')
    .bind(stored.published_attempt_id).all<{ ordinal: number; document: string }>();
  assert.equal(rows.results.length, 4158);
  rows.results.forEach((row, index) => {
    const number = String(index + 1).padStart(4, '0'); assert.equal(row.ordinal, index);
    assert.deepEqual(JSON.parse(row.document), { kind: 'file', entryId: `track-${number}`, name: `Track ${number}.mp3`, fileRef: `track-${number}`,
      info: { contentId: 'fixture-complete-mp3-v1', size: 16044, mediaType: 'audio/mpeg' } });
  });
  const listing = await json<{ name: string }[]>(await call(listingPath));
  assert.deepEqual(listing.map(item => item.name), rows.results.map(row => (JSON.parse(row.document) as { name: string }).name));
  const completed = await json<RefreshView>(await call(resource)); assert.equal(completed.status, 'completed');
  assert.equal(measurements.at(-1)!.pages, 0); assert.equal(measurements.at(-1)!.subrequests, 0);
  const properties = await call('/dav/Paged%20instance/Large/', undefined, 'PROPFIND');
  assert.equal(properties.status, 207); assert.equal(properties.headers.get('X-Probe-plugin-stats'), '0');
  const largeListing = measurements.at(-1)!;
  assert.equal(largeListing.subrequests, 0); assert.equal(largeListing.pages, 0);
  const xml = await properties.text();
  assert.equal((xml.match(/<D:response>/g) ?? []).length, 4159);
  assert.equal((xml.match(/<D:getcontentlength>16044<\/D:getcontentlength>/g) ?? []).length, 4158);

  // Keep at least one further page pending: an accidental step-200 background read would be observable.
  const backgroundInstance = await json<{ ok: boolean; value: { id: string } }>(await call('/api/instances', {
    pluginId: manifest.id, name: 'Background instance', config: {}
  }), 201);
  assert(backgroundInstance.ok);
  const beforeBackground = upstreamRequests;
  const queued = await json<RefreshView>(await call(`/api/instances/${backgroundInstance.value.id}/refresh`, { directoryRef: 'large' }, 'POST', true), 202);
  assert.equal(queued.status, 'queued');
  assert.equal(measurements.at(-1)!.backgroundTasks, 1); assert.equal(measurements.at(-1)!.pages, 1);
  assert.equal(measurements.at(-1)!.subrequests, 1);
  const backgroundResource = `/api/refreshes/${queued.operationId}`;
  const advanced = await json<RefreshView>(await call(backgroundResource, undefined, 'GET', true));
  assert.equal(advanced.current?.pages, 1); assert.equal(advanced.current?.entries, 100);
  assert.equal(measurements.at(-1)!.backgroundTasks, 0); assert.equal(measurements.at(-1)!.pages, 0);
  const stepped = await json<RefreshView>(await call(`${backgroundResource}/step`, {}, 'POST', true));
  assert.equal(stepped.status, 'running'); assert.equal(stepped.current?.pages, 2); assert.equal(stepped.current?.entries, 200);
  assert.equal(measurements.at(-1)!.pages, 1); assert.equal(measurements.at(-1)!.backgroundTasks, 0);
  assert.equal(measurements.at(-1)!.subrequests, 1);
  const unchanged = await json<RefreshView>(await call(backgroundResource, undefined, 'GET', true));
  assert.equal(unchanged.current?.pages, 2); assert.equal(measurements.at(-1)!.pages, 0);
  assert.equal(measurements.at(-1)!.backgroundTasks, 0); assert.equal(upstreamRequests - beforeBackground, 2);
  assert.equal((await json<RefreshView>(await call(backgroundResource, undefined, 'DELETE', true))).status, 'cancelled');
  console.log(JSON.stringify({ runtime: 'local workerd', service: 'formal createWorkerService', pages: steps.length, entries: 4158,
    filesPerPage: '100 × 41 + 58', maxPluginPagesPerStep: Math.max(...steps.map(item => item.pages)),
    maxD1StatementsPerStep: Math.max(...steps.map(item => item.sql)), maxD1StatementsPerHttpRequest: Math.max(...measurements.map(item => item.sql)),
    sqlMeasurement: 'prepare calls; each SQL in batch counted individually; fixture setup/assertion SQL excluded',
    realExternalRequests: largeRequests, maxExternalRequestsPerStep: Math.max(...steps.map(item => item.subrequests)),
    statusGetDoesNotAdvance: true, d1RestartAfterPages: 21, oldSnapshotUntilFinalStep: true, atomicPointerSwitch: true,
    persistedOrderVerified: 4158, waitUntilStartPages: 1, waitUntilStepPages: 1, stepSchedulesNoSecondPage: true,
    allpropFiles: 4158, allpropD1Statements: largeListing.sql, allpropSourceStats: 0, allpropExternalRequests: 0,
    cloudDeploymentTested: false, cloudCpuTested: false, freeQuotaTested: false }));
} finally {
  await mf?.dispose(); await upstream.stop(true); await rm(directory, { recursive: true, force: true });
}
