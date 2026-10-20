import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { D1Database } from '@cloudflare/workers-types';
import type { PluginManifest } from '@musicfs/plugin-api';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { pluginCache, type PluginCacheStore } from '../src/core/sources/cache';
import type { InstallationStore } from '../src/core/extensions';
import type { InstanceStore } from '../src/core/sources';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import { createD1Store } from '../src/infrastructure/persistence/d1';

type Store = InstallationStore & InstanceStore & PluginCacheStore;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const manifest: PluginManifest = { formatVersion: 1, id: 'org.musicfs.cache-fixture', name: 'Cache fixture', version: '1.0.0',
  apiRange: '^0.1.6', hosts: { desktop: 'index.mjs', worker: 'index.mjs' }, configVersion: 1, stateVersion: 1, files: ['index.mjs'] };
function present<T>(value: T | null | undefined): T { if (value == null) throw new Error('Expected cache fixture value'); return value; }

async function setup(adapter: 'SQLite' | 'D1') {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-plugin-cache-'));
  let store: Store; let reopen: () => Promise<void>;
  if (adapter === 'SQLite') {
    const path = join(directory, 'state.sqlite'); let current = openSqlite(path); store = current;
    reopen = async () => { current.close(); current = openSqlite(path); store = current; };
    cleanups.push(async () => { current.close(); await rm(directory, { recursive: true, force: true }); });
  } else {
    const options = { modules: true, script: 'export default {fetch(){return new Response("Cache fixture")}}',
      compatibilityDate: '2026-07-30', d1Databases: { DB: 'plugin-cache-tests' }, d1Persist: directory, log: new Log(LogLevel.ERROR) };
    let mf = new Miniflare(options); let db = await mf.getD1Database('DB') as unknown as D1Database;
    cleanups.push(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
    for (const file of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${file}`).text()).replace(/^\s*--.*$/gm, '').replaceAll('\n', ' '));
    }
    store = createD1Store(db);
    reopen = async () => { await mf.dispose(); mf = new Miniflare(options); db = await mf.getD1Database('DB') as unknown as D1Database; store = createD1Store(db); };
  }
  const installation = await store.activate(manifest, 'revision-one', null);
  for (const id of ['a', 'b']) await store.insert({ id, pluginId: manifest.id, name: id, config: {}, epoch: 1 }, { credential: id }, installation);
  let now = 1000;
  return { get store() { return store; }, reopen, time: (value: number) => { now = value; },
    async cache(id = 'a') { return pluginCache(store, present(await store.capture(id)), new AbortController().signal, () => now); } };
}

for (const adapter of ['SQLite', 'D1'] as const) {
  test(`${adapter}: plugin data persists across reopen and separates instances, expiry and cached null`, async () => {
    const f = await setup(adapter); let a = await f.cache();
    const plan = { source: 'same-audio', segments: [{ bytes: 'small-cover-and-tags' }] };
    await a.putMany!([{ key: 'plan:immutable', value: plan }, { key: 'lyrics:track', value: null, expiresAt: 2000 }]);
    expect(await a.get('lyrics:track')).toBeNull();
    expect(await a.getMany!(['plan:immutable', 'missing', 'lyrics:track', 'plan:immutable'])).toEqual([plan, undefined, null, plan]);
    expect(await (await f.cache('b')).get('plan:immutable')).toBeUndefined();
    await f.reopen(); a = await f.cache();
    expect(await a.get('plan:immutable')).toEqual(plan);
    f.time(2000);
    expect(await a.get('lyrics:track')).toBeUndefined();
    expect(await a.getMany!(['lyrics:track', 'plan:immutable'])).toEqual([undefined, plan]);
    expect(await a.get('plan:immutable')).toEqual(plan);
    await a.put('lyrics:track', { original: '[00:00.00]new lyrics' }, { expiresAt: 3000 });
    expect(await a.get('lyrics:track')).toEqual({ original: '[00:00.00]new lyrics' });
  }, 20_000);

  test(`${adapter}: source changes fence old cache writes, plugin updates replace scope, deletion cascades`, async () => {
    const f = await setup(adapter); const old = await f.cache();
    await old.put('plan', { marker: 'old-account' });
    const before = present(await f.store.capture('a'));
    expect(await f.store.configure(before, { account: 'replacement' }, null)).toBe(true);
    const replacement = await f.cache();
    expect(await replacement.get('plan')).toBeUndefined();
    await replacement.put('plan', { marker: 'new-account' });
    await expect(old.put('plan', { marker: 'late-old-account' })).rejects.toMatchObject({ code: 'stale_call' });
    await expect(old.putMany!([{ key: 'plan', value: 'late' }, { key: 'other', value: 'late' }])).rejects.toMatchObject({ code: 'stale_call' });
    expect(await old.get('plan')).toBeUndefined();
    expect(await replacement.get('plan')).toEqual({ marker: 'new-account' });
    await f.store.activate({ ...manifest, version: '1.0.1' }, 'revision-two', 1);
    const updated = await f.cache();
    expect(await updated.get('plan')).toBeUndefined();
    await updated.put('plan', { marker: 'new-plugin' });
    expect(await updated.get('plan')).toEqual({ marker: 'new-plugin' });
    await f.store.deleteInstance('a');
    await expect(updated.put('plan', null)).rejects.toMatchObject({ code: 'stale_call' });
    expect(await updated.get('plan')).toBeUndefined();
  }, 20_000);
}
