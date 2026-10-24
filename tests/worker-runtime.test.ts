import { expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { D1Database } from '@cloudflare/workers-types';
import type { Entry, PluginManifest, Root } from '@musicfs/plugin-api';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { createD1Store } from '../src/infrastructure/persistence/d1';
import type { RefreshRecord } from '../src/core/library/refresh-types';
import type { SnapshotKey } from '../src/core/library/types';
import { workerCrypto } from '../scripts/helpers/worker-crypto';

test('the production Worker factory reuses completed directory views across HTTP while request context stays current', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-worker-runtime-'));
  const build = await Bun.build({ entrypoints: ['tests/probes/worker-runtime.ts'], target: 'browser', format: 'esm', outdir: directory, naming: 'worker.mjs', plugins: [workerCrypto] });
  if (!build.success) throw new AggregateError(build.logs, 'Worker runtime fixture build failed');
  expect(await build.outputs[0]!.text()).toMatch(/from ["']node:crypto["']/);
  const options = { modulesRoot: directory, modules: [{ type: 'ESModule' as const, path: join(directory, 'worker.mjs') }],
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'worker-runtime-tests' }, d1Persist: join(directory, 'd1'), log: new Log(LogLevel.ERROR) };
  let mf = new Miniflare(options);
  const username = 'reader'; const password = 'fixture-password';
  const auth = { Authorization: 'Basic ' + btoa(`${username}:${password}`) };
  const file = (index: number) => `http://fixture/dav/${encodeURIComponent('实例')}/${encodeURIComponent('音乐')}/${String(index).padStart(4, '0')}.wav`;
  try {
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()).replace(/^\s*--.*$/gm, '').replaceAll('\n', ' '));
    }
    const store = createD1Store(db);
    const manifest: PluginManifest = { formatVersion: 1, id: 'org.musicfs.runtime-fixture', name: 'Runtime fixture', version: '1.0.0',
      apiRange: '^0.1.7', configVersion: 1, stateVersion: 1, hosts: { worker: 'index.mjs' }, files: ['index.mjs'] };
    const installation = await store.activate(manifest, 'a'.repeat(64), null);
    await store.insert({ id: 'instance', pluginId: manifest.id, name: '实例', config: {}, epoch: 1 }, null, installation);
    const captured = (await store.capture('instance'))!;
    const stamp = { id: captured.id, pluginId: captured.pluginId, epoch: captured.epoch, pluginRevision: captured.pluginRevision, pluginGeneration: captured.pluginGeneration };
    const seed = async (key: SnapshotKey, items: Root[] | Entry[]) => {
      const operationId = crypto.randomUUID(); const date = new Date().toISOString();
      const record: RefreshRecord = { operationId, stamp, scope: { kind: 'directory', ...(key.kind === 'directory' ? { directoryRef: key.ref } : {}) },
        status: 'queued', revision: 1, leaseToken: null, leaseUntil: null, task: { key, attemptId: operationId, pages: 0, entries: 0, children: [] },
        pending: [], seen: [], known: [], refreshedDirectories: 0, failures: [], createdAt: date, updatedAt: date };
      await store.createRefresh(record, true);
      const claimed = (await store.claimRefresh(operationId, 'fixture', Date.now(), Date.now() + 60_000))!;
      expect(await store.commitRefresh(claimed, { ...claimed, revision: claimed.revision + 1, status: 'completed', leaseToken: null, leaseUntil: null },
        { items, publish: { stamp, kind: key.kind, id: operationId, completedAt: date } }, undefined)).toBe('committed');
    };
    await seed({ kind: 'roots', ref: '' }, [{ sourceId: 'music', name: '音乐', directoryRef: 'music' }]);
    await seed({ kind: 'directory', ref: 'music' }, Array.from({ length: 4000 }, (_, index) => ({ kind: 'file' as const, entryId: String(index),
      name: `${String(index).padStart(4, '0')}.wav`, fileRef: `曲目:${index}`, info: { contentId: 'fixture-fixed', size: 8, mediaType: 'audio/wav' } })));

    const first = await mf.dispatchFetch(file(0), { method: 'HEAD', headers: auth });
    expect(first.status).toBe(200); expect(first.headers.get('Content-Length')).toBe('8');
    const expected = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['instance', '曲目:0', 'fixture-fixed', 8, 'audio/wav'])));
    expect(first.headers.get('ETag')).toBe('"' + Array.from(new Uint8Array(expected), byte => byte.toString(16).padStart(2, '0')).join('') + '"');
    expect(first.headers.get('X-Probe-Snapshot-Reads')).toBe('2'); expect(first.headers.get('X-Probe-Snapshot-Rows')).toBe('4001');
    for (const index of [100, 999, 2000, 3999]) {
      const next = await mf.dispatchFetch(file(index), { method: 'HEAD', headers: auth });
      expect(next.status).toBe(200); expect(next.headers.get('X-Probe-Binding')).toBe(first.headers.get('X-Probe-Binding'));
      expect(next.headers.get('X-Probe-Snapshot-Reads')).toBe('0'); expect(next.headers.get('X-Probe-Snapshot-Rows')).toBe('0');
    }
    const audio = await mf.dispatchFetch(file(2000), { headers: auth });
    expect(await audio.text()).toBe('ABCDEFGH'); expect(audio.headers.get('X-Probe-Snapshot-Reads')).toBe('0');
    const range = await mf.dispatchFetch(file(3999), { headers: { ...auth, Range: 'bytes=2-3' } });
    expect(range.status).toBe(206); expect(await range.text()).toBe('CD'); expect(range.headers.get('X-Probe-Snapshot-Reads')).toBe('0');

    // Reusing the core must not pin the first request's DAV/admin credentials or asset binding.
    const rotated = { 'X-Probe-Credentials': 'rotated' };
    const denied = await mf.dispatchFetch(file(0), { method: 'HEAD', headers: { ...auth, ...rotated } });
    expect(denied.status).toBe(401);
    const newCredentials = await mf.dispatchFetch(file(0), { method: 'HEAD', headers: { ...rotated, Authorization: 'Basic ' + btoa('reader:rotated-password') } });
    expect(newCredentials.status).toBe(200); expect(newCredentials.headers.get('X-Probe-Snapshot-Reads')).toBe('0');
    const status = await mf.dispatchFetch('http://fixture/api/status', { headers: { ...rotated, Authorization: 'Bearer rotated-admin' } });
    expect(status.status).toBe(200); await status.body?.cancel();
    const assets = await mf.dispatchFetch('http://fixture/', { headers: { 'X-Probe-Assets': 'latest-binding' } });
    expect(await assets.text()).toBe('latest-binding');
    const inspection = await mf.dispatchFetch('http://fixture/api/plugins/inspect-url', { method: 'POST',
      headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: new URL('/plugin-packages/fixture.zip', await mf.ready).href }) });
    expect(inspection.status).toBe(200);
    expect(await inspection.json()).toMatchObject({ manifest: { id: 'org.musicfs.package-fixture' } });

    // Each start gets a new wrapper/context. Its page belongs to that invocation's waitUntil.
    for (const ref of ['background-a', 'background-b']) {
      const started = await mf.dispatchFetch('http://fixture/api/instances/instance/refresh', { method: 'POST',
        headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' }, body: JSON.stringify({ directoryRef: ref }) });
      expect(started.status).toBe(202); expect(started.headers.get('X-Probe-Background')).toBe('1');
      const value = await started.json() as { operationId: string };
      expect((await store.refreshRecord(value.operationId))?.status).toBe('completed');
    }

    await mf.dispose(); mf = new Miniflare(options);
    const cold = await mf.dispatchFetch(file(3999), { method: 'HEAD', headers: auth });
    expect(cold.status).toBe(200); expect(cold.headers.get('X-Probe-Snapshot-Reads')).toBe('2');
    expect(cold.headers.get('X-Probe-Snapshot-Rows')).toBe('4001');

    // Force two independent cold requests to overlap while the first has local D1 work pending.
    // The shared result contains parsed immutable view data, never a Response, stream, or request signal.
    await mf.dispose(); mf = new Miniflare(options);
    const simultaneous = await Promise.all([
      mf.dispatchFetch(file(0), { method: 'HEAD', headers: { ...auth, 'X-Probe-Cold-Delay': 'yes' } }),
      mf.dispatchFetch(file(3999), { method: 'HEAD', headers: auth })
    ]);
    for (const response of simultaneous) expect(response.status).toBe(200);
    const afterOverlap = await mf.dispatchFetch(file(2000), { method: 'HEAD', headers: auth });
    expect(afterOverlap.status).toBe(200); expect(afterOverlap.headers.get('X-Probe-Snapshot-Reads')).toBe('0');
    expect(afterOverlap.headers.get('X-Probe-Total-Snapshot-Reads')).toBe('2');
    expect(afterOverlap.headers.get('X-Probe-Total-Snapshot-Rows')).toBe('4001');
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 20_000);
