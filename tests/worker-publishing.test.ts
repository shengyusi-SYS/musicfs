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
    setOutcome(next: typeof outcome) { outcome = next; } };
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
  const controller = () => createWorkerChanges({ db, registrations: [], waitUntil: promise => work.push(promise),
    accountId: 'fixture-account', scriptName: 'musicfs', apiToken: 'fixture-cloudflare-token', fetcher: remote.fetcher });
  const drain = async () => { while (work.length) await Promise.all(work.splice(0)); };
  const store = createD1Store(db);
  return { db, remote, controller, drain, store };
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
  const before = await db.prepare('SELECT status FROM worker_plugin_changes WHERE operation_id = ?').bind(operation.operationId).first<{ status: string }>();
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
