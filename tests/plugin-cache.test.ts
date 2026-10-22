import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { D1Database } from '@cloudflare/workers-types';
import type { Json, PluginManifest } from '@musicfs/plugin-api';
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
    async cache(id = 'a', spend?: (amount: number) => void) { return pluginCache(store, present(await store.capture(id)), new AbortController().signal, () => now, spend); } };
}

for (const adapter of ['SQLite', 'D1'] as const) {
  test(`${adapter}: policy-only config writes retain authentication and cache across reopen while fencing old private-state writes`, async () => {
    const f = await setup(adapter); const initial = present(await f.store.capture('a'));
    const { id, pluginId, epoch, pluginRevision, pluginGeneration } = initial;
    const auth = { operationId: crypto.randomUUID(), revision: 1, stamp: { id, pluginId, epoch: epoch + 1, pluginRevision, pluginGeneration },
      step: { kind: 'complete' as const, accountName: 'Fixture' } };
    expect(await f.store.advanceAuthentication(initial, auth)).toBe(true);
    const before = present(await f.store.capture('a')); await (await f.cache()).put('retained', 'yes');
    expect(await f.store.configure(before, { retention: 365 }, before.privateState, true)).toBe(true);
    expect(await f.store.saveState(before, { stale: true })).toBe(false);
    await f.reopen();
    expect(await f.store.capture('a')).toMatchObject({ epoch: before.epoch, authentication: auth, config: { retention: 365 }, privateState: before.privateState });
    expect(await (await f.cache()).get('retained')).toBe('yes');
  }, 20_000);

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

  test(`${adapter}: atomic cache reservation freezes a concurrent winner, including null, across reopen`, async () => {
    const f = await setup(adapter); const costs: number[] = [];
    const contenders = await Promise.all([f.cache('a', amount => costs.push(amount)), f.cache(), f.cache()]);
    const winners = await Promise.all(contenders.map((cache, contender) => cache.putIfAbsent!('frozen-plan', { contender })));
    const winner = winners[0] as Json;
    expect(winners).toEqual([winner, winner, winner]);
    expect(await contenders[0]!.putIfAbsent!('frozen-plan', { contender: 'late' })).toEqual(winner);
    expect(costs).toEqual([3, 2]);
    expect(await contenders[0]!.putIfAbsent!('empty-plan', null)).toBeNull();
    expect(await contenders[1]!.putIfAbsent!('empty-plan', { contender: 'late' })).toBeNull();
    expect(await (await f.cache('b')).putIfAbsent!('frozen-plan', { contender: 'other-source' })).toEqual({ contender: 'other-source' });
    await f.reopen();
    const reopened = await f.cache();
    expect(await reopened.putIfAbsent!('frozen-plan', { contender: 'after-reopen' })).toEqual(winner);
    expect(await reopened.get('empty-plan')).toBeNull();
    await expect(reopened.putIfAbsent!('oversized-plan', 'x'.repeat(1_048_576))).rejects.toThrow('Plugin cache value exceeds 1 MiB');
  }, 20_000);

  test(`${adapter}: reservation replaces expired data and fences late writes after source/plugin invalidation`, async () => {
    const f = await setup(adapter); const old = await f.cache();
    await old.put('plan', { marker: 'expired' }, { expiresAt: 2000 });
    f.time(2000);
    // put already ran cleanup in this invocation; the conditional insert must handle expiry itself.
    expect(await old.putIfAbsent!('plan', { marker: 'first-immutable' })).toEqual({ marker: 'first-immutable' });
    f.time(3000);
    expect(await old.putIfAbsent!('plan', { marker: 'late' })).toEqual({ marker: 'first-immutable' });
    const staleUncleaned = await f.cache(); const before = present(await f.store.capture('a'));
    expect(await f.store.configure(before, { account: 'replacement' }, null)).toBe(true);
    await expect(old.putIfAbsent!('plan', { marker: 'stale-source' })).rejects.toMatchObject({ code: 'stale_call' });
    const replacement = await f.cache();
    await replacement.putIfAbsent!('cleanup-already-ran', null);
    expect(await replacement.putIfAbsent!('plan', { marker: 'new-account' })).toEqual({ marker: 'new-account' });
    await expect(staleUncleaned.putIfAbsent!('plan', null)).rejects.toMatchObject({ code: 'stale_call' });
    await expect(old.putIfAbsent!('plan', null)).rejects.toMatchObject({ code: 'stale_call' });
    expect(await replacement.get('plan')).toEqual({ marker: 'new-account' });
    await f.store.activate({ ...manifest, version: '1.0.1' }, 'revision-two', 1);
    await expect(replacement.putIfAbsent!('plan', null)).rejects.toMatchObject({ code: 'stale_call' });
    const updated = await f.cache();
    expect(await updated.putIfAbsent!('plan', { marker: 'new-plugin' })).toEqual({ marker: 'new-plugin' });
    await f.store.deleteInstance('a');
    await expect(updated.putIfAbsent!('plan', null)).rejects.toMatchObject({ code: 'stale_call' });
  }, 20_000);
}

test('hosts without atomic cache storage do not advertise reservations', () => {
  const unavailable = () => { throw new Error('Should not access storage'); };
  const store: PluginCacheStore = { cachedPluginData: unavailable, cachePluginData: unavailable };
  const cache = pluginCache(store, { id: 'a', pluginId: manifest.id, epoch: 1, pluginRevision: 'one', pluginGeneration: 1 }, new AbortController().signal, () => 0);
  expect(cache.putIfAbsent).toBeUndefined();
});
