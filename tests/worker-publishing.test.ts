import { afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, Log, LogLevel } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import { createWorkerChanges } from '../src/hosts/worker/changes';
import { createD1Store } from '../src/infrastructure/persistence/d1';
import { readPackage } from '../src/infrastructure/archives';
import type { WorkerArtifact, WorkerModule } from '../src/hosts/worker/publisher';
import type { RegisteredPlugin } from '../src/hosts/worker/plugins';
import { createWorkerRegistry } from '../src/hosts/worker/plugins';
import { createSources } from '../src/core/sources';
import { workerMigrationFixture } from './fixtures/worker-migration';
import createWorker, { type WorkerBindings } from '../src/worker';

let archive: Uint8Array;
const cleanup: (() => Promise<void>)[] = [];
const signal = () => new AbortController().signal;
beforeAll(async () => {
  const file = Bun.file('dist/plugins/org.musicfs.sample.zip');
  if (!await file.exists()) throw new Error('Build the sample ZIP before Worker publication tests');
  archive = new Uint8Array(await file.arrayBuffer());
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const encoder = new TextEncoder();
const module = (name: string, code: string): WorkerModule => ({ name, type: 'esm', bytes: encoder.encode(code) });

/** Only the remote platform is controlled; request encoding, SDK auth and D1 remain real. */
function platform() {
  let artifact: WorkerArtifact = { mainModule: 'worker.mjs', modules: [
    module('worker.mjs', "import createWorker from './core.mjs';import {registrations} from './registry.mjs';export default createWorker(registrations);"),
    module('core.mjs', 'export function assertPluginModule(){};export default function createWorker(){return {fetch(){return new Response("fixture")}}}'),
    module('registry.mjs', 'export const registrations=[];')
  ] };
  let puts = 0; let gets = 0; let outcome: 'success' | 'lost-response' | 'rejected' = 'success';
  let beforePut: (() => Promise<void>) | undefined;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url);
    expect(request.headers.get('authorization')).toBe('Bearer fixture-cloudflare-token');
    const content = '/client/v4/accounts/fixture-account/workers/scripts/musicfs/content';
    if (request.method === 'GET' && url.pathname === content + '/v2') {
      gets++;
      const form = new FormData(); form.set('metadata', JSON.stringify({ main_module: artifact.mainModule }));
      for (const item of artifact.modules) form.set(item.name, new File([item.bytes.slice().buffer], item.name,
        { type: item.type === 'esm' ? 'application/javascript+module' : item.type === 'text' ? 'text/plain' : 'application/octet-stream' }));
      const response = new Response(form); response.headers.set('cf-worker-main-module-part', artifact.mainModule);
      response.headers.set('content-type', response.headers.get('content-type')!.replace('multipart/form-data', 'multipart/mixed'));
      return response;
    }
    if (request.method === 'PUT' && url.pathname === content) {
      puts++;
      await beforePut?.();
      expect(request.headers.get('cf-worker-main-module-part')).toBe('worker.mjs');
      const form = await request.formData();
      const metadata = form.get('metadata'); expect(typeof metadata).toBe('string');
      expect(JSON.parse(metadata as string)).toEqual({ main_module: 'worker.mjs' });
      const modules: WorkerModule[] = [];
      for (const [name, value] of form.entries()) {
        if (name === 'metadata') continue;
        const part: unknown = value; expect(part).toBeInstanceOf(File);
        if (!(part instanceof File)) throw new Error('Module parts must be named files');
        expect(part.name).toBe(name);
        modules.push({ name, type: /javascript/.test(part.type) ? 'esm' : part.type.startsWith('text/') ? 'text' : 'data',
          bytes: new Uint8Array(await part.arrayBuffer()) });
      }
      expect(modules.map(item => item.name)).toEqual(expect.arrayContaining(['worker.mjs', 'core.mjs', 'registry.mjs']));
      // Configuration is absent from this code-only request: platform-owned settings stay intact.
      expect([...form.keys()].some(name => name.startsWith('metadata[') || ['bindings', 'assets', 'secrets'].includes(name))).toBe(false);
      if (outcome === 'rejected') return Response.json({ success: false, errors: [{ code: 10021, message: 'Invalid Worker module' }], messages: [] }, { status: 400 });
      artifact = { mainModule: 'worker.mjs', modules };
      if (outcome === 'lost-response') throw new TypeError('Connection closed after the platform accepted the modules');
      return Response.json({ success: true, errors: [], messages: [], result: { id: 'musicfs' } });
    }
    throw new Error(`Unexpected Cloudflare request: ${request.method} ${url.pathname}`);
  }) as typeof fetch;
  return { fetcher, get artifact() { return artifact; }, get puts() { return puts; }, get gets() { return gets; },
    setOutcome(next: typeof outcome) { outcome = next; }, beforeUpload(check: () => Promise<void>) { beforePut = check; } };
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-publication-test-'));
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("D1 fixture")}}',
    compatibilityDate: '2026-07-30', d1Databases: { DB: 'publication-tests' }, d1Persist: directory, log: new Log(LogLevel.ERROR) });
  cleanup.push(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()).replace(/^\s*--.*$/gm, '').replaceAll('\n', ' '));
  }
  const remote = platform(); const work: Promise<unknown>[] = [];
  const controller = (registrations: RegisteredPlugin[] = []) => createWorkerChanges({ db, registrations, waitUntil: promise => work.push(promise),
    accountId: 'fixture-account', scriptName: 'musicfs', apiToken: 'fixture-cloudflare-token', fetcher: remote.fetcher });
  const drain = async () => { while (work.length) await Promise.all(work.splice(0)); };
  const store = createD1Store(db);
  return { db, directory, remote, controller, drain, store };
}

test('Worker publication installs through the official SDK, persists progress, and removes without deleting instances or layout', async () => {
  const { remote, controller, drain, store } = await setup();
  const changes = controller(); const operation = await changes.install(archive, signal());
  await drain();
  const installed = await store.installation('org.musicfs.sample'); expect(installed?.status).toBe('active');
  expect(await controller().get(operation.operationId)).toMatchObject({ status: 'completed', installation: { revision: installed!.revision } });
  expect(remote.puts).toBe(1);
  expect(await store.insert({ id: 'retained-instance', pluginId: installed!.manifest.id, name: '保留实例', config: {}, epoch: 1 }, null, installed!)).toBe(true);
  const nodes = [{ kind: 'source' as const, id: 'retained-source', name: '保留入口', instanceId: 'retained-instance', sourceId: 'audio' }];
  expect(await store.saveLayout(0, nodes)).toBe(true);
  const removal = await controller().remove(installed!.manifest.id, signal()); await drain();
  expect(await controller().get(removal.operationId)).toMatchObject({ status: 'completed', installation: { status: 'missing' } });
  expect((await store.instances())[0]!.id).toBe('retained-instance'); expect((await store.layout()).nodes).toEqual(nodes);
  expect(remote.puts).toBe(2);
});

test('a lost upload response is recovered by a new controller verifying registry content without another upload', async () => {
  const { db, remote, controller, drain, store } = await setup();
  remote.setOutcome('lost-response');
  const operation = await controller().install(archive, signal()); await drain();
  const before = await db.prepare('SELECT status FROM plugin_changes WHERE operation_id = ?').bind(operation.operationId).first<{ status: string }>();
  expect(before?.status).toBe('verifying'); expect(await store.installation(operation.pluginId)).toBeUndefined(); expect(remote.puts).toBe(1);
  const restored = controller(); expect(await restored.get(operation.operationId)).toMatchObject({ status: 'verifying' }); await drain();
  expect(await restored.get(operation.operationId)).toMatchObject({ status: 'completed', installation: { status: 'active' } });
  expect(remote.puts).toBe(1); expect(remote.gets).toBe(2);
});

test('an explicit platform rejection fails the change and keeps the previous active installation', async () => {
  const { remote, controller, drain, store } = await setup();
  const prepared = await readPackage(archive, 'worker', signal()); const revision = 'a'.repeat(64);
  const previous = await store.activate({ ...prepared.manifest, version: '0.0.1' }, revision, null);
  remote.artifact.modules.push({ name: `plugins/${revision}/index.mjs`, type: 'esm', bytes: prepared.files.get('index.mjs')! });
  remote.setOutcome('rejected');
  const operation = await controller().install(archive, signal()); await drain();
  expect(await controller().get(operation.operationId)).toMatchObject({ status: 'failed' });
  expect(await store.installation(operation.pluginId)).toEqual(previous); expect(remote.puts).toBe(1);
});

test('schema migration waits for the exact candidate and new Worker calls migrate one instance before a separate atomic activation', async () => {
  const { db, directory, remote, controller, drain, store } = await setup();
  const v1 = await workerMigrationFixture(directory, 1); const v2 = await workerMigrationFixture(directory, 2);
  const previous = await store.activate(v1.prepared.manifest, v1.prepared.digest, null);
  remote.artifact.modules.push(module(`plugins/${v1.prepared.digest}/index.mjs`, new TextDecoder().decode(v1.prepared.files.get('index.mjs'))));
  for (const id of ['a', 'b']) expect(await store.insert({ id, pluginId: previous.manifest.id, name: `实例${id}`, config: { label: `目录${id}` }, epoch: 1 }, { token: `fixture-secret-${id}` }, previous)).toBe(true);
  const before = await Promise.all(['a', 'b'].map(id => store.capture(id)));
  const nodes = [{ kind: 'source' as const, id: 'export', name: '保留布局', instanceId: 'a', sourceId: 'root' }];
  expect(await store.saveLayout(0, nodes)).toBe(true);
  remote.beforeUpload(async () => {
    const record = await db.prepare('SELECT document FROM plugin_changes WHERE status NOT IN (\'completed\',\'failed\')').first<{ document: string }>();
    const staged = JSON.parse(record!.document);
    expect(staged).toMatchObject({ inputsCaptured: true, stagingReady: true, previousManifest: { stateVersion: 1 } });
    expect(staged.registry).toContain('MusicFS change'); expect(staged.attemptedAt).toBeNumber();
  });
  remote.setOutcome('lost-response');
  const old = controller([v1.registration]); const operation = await old.install(v2.archive, signal()); await drain();
  expect(await store.installation(operation.pluginId)).toEqual(previous); expect(remote.puts).toBe(1);
  expect(await store.changeRecord(operation.operationId)).toMatchObject({ inputsCaptured: true, view: { status: 'verifying' } });
  // Old code verifies the accepted PUT, but never runs a different revision or activates it.
  expect(await old.stepNext(signal())).toBe(true);
  expect(await store.changeRecord(operation.operationId)).toMatchObject({ codeReady: true, view: { status: 'migrating' } });
  expect(v1.validationCalls).toEqual([]); expect(v2.validationCalls).toEqual([]);
  expect(await store.installation(operation.pluginId)).toEqual(previous);
  expect(await old.get(operation.operationId)).toMatchObject({ status: 'migrating' }); await drain();
  expect(v2.validationCalls).toEqual([]); expect(remote.puts).toBe(1); expect(remote.gets).toBe(2);

  const registrations = [v1.registration, v2.registration];
  expect(await controller(registrations).stepNext(signal())).toBe(true);
  expect(v2.validationCalls).toEqual(['a']);
  expect(await Promise.all(['a', 'b'].map(id => store.capture(id)))).toEqual(before);
  expect(await store.installation(operation.pluginId)).toEqual(previous);
  const env: WorkerBindings = { DB: db, ASSETS: { fetch: async () => new Response('fixture assets') }, ADMIN_TOKEN: 'fixture-admin', DAV_USERNAME: 'reader', DAV_PASSWORD: 'fixture-dav',
    CF_ACCOUNT_ID: 'fixture-account', CF_WORKER_NAME: 'musicfs', CF_API_TOKEN: 'fixture-cloudflare-token' };
  // Invoke the real scheduled entry with a newly built registration set, without
  // an open management page. One call prepares only the second instance.
  await createWorker(registrations).scheduled({}, env);
  expect(v2.validationCalls).toEqual(['a', 'b']); expect(await store.installation(operation.pluginId)).toEqual(previous);
  await createWorker(registrations).scheduled({}, env);
  expect(v2.validationCalls).toEqual(['a', 'b']);
  expect(await store.installation(operation.pluginId)).toMatchObject({ manifest: { version: '2.0.0' }, revision: v2.prepared.digest, generation: 2, status: 'active' });
  const completed = await controller(registrations).get(operation.operationId);
  expect(completed).toMatchObject({ status: 'completed', installation: { revision: v2.prepared.digest } });
  expect(JSON.stringify(completed)).not.toContain('fixture-secret'); expect(JSON.stringify(completed)).not.toContain('privateState');
  const sources = createSources(store, createWorkerRegistry(store, registrations));
  for (const id of ['a', 'b']) {
    expect(await sources.roots(id, signal())).toMatchObject({ ok: true, value: { items: [{ name: `目录${id}` }] } });
    expect(await store.capture(id)).toMatchObject({ id, config: { title: `目录${id}` }, privateState: { session: { token: `fixture-secret-${id}` }, version: 2 }, epoch: 2, stateRevision: 2 });
  }
  expect((await store.layout()).nodes).toEqual(nodes); expect(remote.puts).toBe(1);
  expect((await db.prepare('SELECT COUNT(*) AS count FROM worker_plugin_change_files WHERE operation_id = ?').bind(operation.operationId).first<{ count: number }>())?.count).toBe(0);
  expect(await controller(registrations).stepNext(signal())).toBe(false);
});

test('a failed candidate after one prepared instance retains both old instances and their executable revision', async () => {
  const { directory, remote, controller, drain, store } = await setup();
  const v1 = await workerMigrationFixture(directory, 1); const v2 = await workerMigrationFixture(directory, 2);
  const previous = await store.activate(v1.prepared.manifest, v1.prepared.digest, null);
  remote.artifact.modules.push(module(`plugins/${v1.prepared.digest}/index.mjs`, new TextDecoder().decode(v1.prepared.files.get('index.mjs'))));
  for (const id of ['a', 'b']) expect(await store.insert({ id, pluginId: previous.manifest.id, name: id, config: { label: id }, epoch: 1 },
    { token: `fixture-secret-${id}`, reject: id === 'b' }, previous)).toBe(true);
  const before = await Promise.all(['a', 'b'].map(id => store.capture(id)));
  const operation = await controller([v1.registration]).install(v2.archive, signal()); await drain();
  const registrations = [v1.registration, v2.registration];
  await controller(registrations).stepNext(signal()); expect(v2.validationCalls).toEqual(['a']);
  await controller(registrations).stepNext(signal());
  expect(await controller(registrations).get(operation.operationId)).toMatchObject({ status: 'failed', error: { code: 'migration_failed' } });
  expect(await store.installation(operation.pluginId)).toEqual(previous);
  expect(await Promise.all(['a', 'b'].map(id => store.capture(id)))).toEqual(before);
  const sources = createSources(store, createWorkerRegistry(store, registrations));
  expect(await sources.roots('b', signal())).toMatchObject({ ok: true, value: { items: [{ name: 'b' }] } });
  expect(remote.artifact.modules.some(item => item.name === `plugins/${previous.revision}/index.mjs`)).toBe(true);
  expect(remote.puts).toBe(1);
});

test('GET and scheduled steps cannot publish incomplete staging; an abandoned staging checkpoint fails without touching the platform', async () => {
  const { db, controller, drain, remote, store } = await setup();
  const prepared = await readPackage(archive, 'worker', signal()); const id = crypto.randomUUID(); const now = Date.now();
  const timestamp = new Date(now).toISOString();
  expect(await store.createChange({ view: { operationId: id, pluginId: prepared.manifest.id, kind: 'install', status: 'queued', createdAt: timestamp, updatedAt: timestamp },
    expectedGeneration: null, manifest: prepared.manifest, revision: prepared.digest, stagingReady: false })).toBe(true);
  await db.prepare('INSERT INTO worker_plugin_change_files (operation_id, name, chunk_index, bytes) VALUES (?, ?, 0, ?)').bind(id, 'index.mjs', encoder.encode('partial fixture')).run();
  expect(await controller().get(id)).toMatchObject({ status: 'queued' }); await drain();
  expect(await controller().stepNext(signal())).toBe(true);
  expect(remote.puts).toBe(0); expect(remote.gets).toBe(0); expect(await store.installation(prepared.manifest.id)).toBeUndefined();
  const token = crypto.randomUUID(); const lease = await store.claimChange(id, token, now, now + 60_000); expect(lease).not.toBeNull();
  expect(await store.commitChange(lease!, { ...lease!.record, view: { ...lease!.record.view, createdAt: new Date(now - 121_000).toISOString() } }, { kind: 'checkpoint' }, now)).not.toBeNull();
  await store.releaseChange(id, token);
  await controller().stepNext(signal());
  expect(await controller().get(id)).toMatchObject({ status: 'failed', error: { code: 'staging_failed' } });
  expect(remote.puts).toBe(0); expect(remote.gets).toBe(0); expect(await store.installation(prepared.manifest.id)).toBeUndefined();
  expect((await db.prepare('SELECT COUNT(*) AS count FROM worker_plugin_change_files WHERE operation_id = ?').bind(id).first<{ count: number }>())?.count).toBe(0);
});
