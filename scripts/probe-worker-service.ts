import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { buildWorker, type WorkerBundle } from './build-worker';
import { requestReady } from './helpers/refresh-http';

const archive = 'dist/plugins/org.musicfs.sample.zip';
assert(await Bun.file(archive).exists(), 'Build the sample plugin before this probe; it does not rebuild plugin artifacts');
assert(await Bun.file('dist/web/index.html').exists(), 'Build the WebUI before this probe');
const bundle = await buildWorker({ pluginArchives: [archive], entrypoint: 'tests/probes/worker-service.ts' });
const directory = resolve('dist/worker');
const persistence = await mkdtemp(join(tmpdir(), 'musicfs-worker-service-'));
function runtime(description: WorkerBundle, brokenModule?: string) {
  return new Miniflare({ modulesRoot: directory,
    modules: description.modules.map(module => ({ type: module.type === 'esm' ? 'ESModule' as const : module.type === 'text' ? 'Text' as const : 'Data' as const,
      path: resolve(directory, module.file), ...(module.name === brokenModule ? { contents: 'export default {};' } : {}) })),
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'musicfs-product-probe' }, d1Persist: persistence,
    assets: { directory: resolve(directory, 'web'), binding: 'ASSETS', routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true } },
    bindings: { ADMIN_TOKEN: 'fixture-admin', DAV_USERNAME: 'reader', DAV_PASSWORD: 'fixture-password',
      CF_ACCOUNT_ID: '', CF_WORKER_NAME: '', CF_API_TOKEN: '' }, log: new Log(LogLevel.ERROR) });
}
const headers = { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' };
const dav = 'Basic ' + Buffer.from('reader:fixture-password').toString('base64');
let mf = runtime(bundle);
const ready = (url: string, init?: RequestInit) => requestReady((path, options) => mf.dispatchFetch(path, { ...options, headers: Object.fromEntries(new Headers(options?.headers)) }), url, init, headers);
try {
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text();
    await db.exec(sql.replace(/^\s*--.*$/gm, '').replaceAll('\n', ' '));
  }
  const page = await mf.dispatchFetch('http://musicfs/');
  assert.equal(page.status, 200); assert((await page.text()).includes('<div id="root">'));
  const status = await mf.dispatchFetch('http://musicfs/api/status', { headers });
  assert.equal(status.status, 200); assert.equal((await status.json() as { host: string }).host, 'worker');
  const empty = await mf.dispatchFetch('http://musicfs/api/plugins', { headers });
  assert.equal(empty.status, 200); assert.deepEqual(await empty.json(), []);
  const unavailable = await mf.dispatchFetch('http://musicfs/api/plugins', { method: 'POST', headers: { Authorization: headers.Authorization },
    body: await Bun.file(archive).arrayBuffer() });
  assert.equal(unavailable.status, 503); assert.equal((await unavailable.json() as { error: string }).error, 'host_not_configured');
  const unknownOperation = await mf.dispatchFetch('http://musicfs/api/plugin-changes/unknown', { headers });
  assert.equal(unknownOperation.status, 404); await unknownOperation.body?.cancel();
  const initial = bundle.plugins[0]!;
  // Fixture setup is explicit. Loading code into a registry never activates an installation.
  await db.prepare("INSERT INTO installations (id, manifest, revision, generation, status) VALUES (?, ?, ?, 1, 'active')")
    .bind(initial.manifest.id, JSON.stringify(initial.manifest), initial.revision).run();
  const created = await mf.dispatchFetch('http://musicfs/api/instances', { method: 'POST', headers,
    body: JSON.stringify({ pluginId: initial.manifest.id, name: 'Worker 实例', config: { label: '正式目录' } }) });
  assert.equal(created.status, 201); const result = await created.json() as { ok: boolean; value: { id: string } }; assert(result.ok);
  const file = 'http://musicfs/dav/' + ['Worker 实例', '正式目录', '440 Hz.wav'].map(encodeURIComponent).join('/');
  const listing = await ready('http://musicfs/dav/', { method: 'PROPFIND', headers: { Authorization: dav, Depth: '1' } });
  assert.equal(listing.status, 207); assert((await listing.text()).includes(encodeURIComponent('Worker 实例')));
  const head = await ready(file, { method: 'HEAD', headers: { Authorization: dav } });
  assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), '16044');
  const audio = await ready(file, { headers: { Authorization: dav, Range: 'bytes=0-3' } });
  assert.equal(audio.status, 206); assert.equal(audio.headers.get('Content-Length'), '4'); assert.equal(await audio.text(), 'RIFF');
  await mf.dispose(); mf = runtime(bundle);
  const retained = await mf.dispatchFetch('http://musicfs/api/instances', { headers });
  assert.equal(retained.status, 200); assert.equal((await retained.json() as { id: string }[])[0]!.id, result.value.id);
  const configuration = await mf.dispatchFetch(`http://musicfs/api/plugins/${initial.manifest.id}/configuration`, { headers });
  assert.equal(configuration.status, 200); await configuration.body?.cancel();
  const unavailableRemoval = await mf.dispatchFetch(`http://musicfs/api/plugins/${initial.manifest.id}`, { method: 'DELETE', headers });
  assert.equal(unavailableRemoval.status, 503); await unavailableRemoval.body?.cancel();
  const broken = runtime(bundle, `plugins/${initial.revision}/${initial.manifest.hosts.worker}`);
  try { await assert.rejects(broken.ready); } finally { await broken.dispose().catch(() => {}); }
  console.log(JSON.stringify({ entry: 'src/worker.ts', runtime: 'local workerd', sharedManagementApi: true, staticWebUI: true,
    separateRegistry: true, prebuiltPluginModules: true, registryDoesNotActivate: true, d1RestartPersistence: true,
    missingPublicationCredentialsDiagnosed: true, invalidPluginRejectedAtStartup: true,
    davHead: 16044, rangeBytes: 'RIFF', nodeCompatibility: true, cloudDeploymentTested: false, freeQuotaTested: false }));
} finally { await mf.dispose(); await rm(persistence, { recursive: true, force: true }); }
