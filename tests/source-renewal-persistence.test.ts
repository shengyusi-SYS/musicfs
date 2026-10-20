import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Log, LogLevel, Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { PluginFault, PluginManifest } from '@musicfs/plugin-api';
import type { InstallationStore } from '../src/core/extensions';
import type { AuthenticationRecord, InstanceSnapshot, InstanceStore } from '../src/core/sources/types';
import type { RenewalClaim, RenewalStore } from '../src/core/sources/renewal';
import { createD1Store } from '../src/infrastructure/persistence/d1';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';

type Store = InstallationStore & InstanceStore & RenewalStore;
type Adapter = 'SQLite' | 'D1';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const manifest: PluginManifest = { formatVersion: 1, id: 'org.musicfs.renewal-fixture', name: 'Renewal fixture', version: '1.0.0', apiRange: '^0.1.4',
  hosts: { desktop: 'index.mjs', worker: 'index.mjs' }, configVersion: 1, stateVersion: 1, files: ['index.mjs'] };
const failure: PluginFault = { kind: 'temporary', message: 'Fixture upstream unavailable', retryAfterSeconds: 2 };
function present<T>(value: T | null | undefined): T { if (value == null) throw new Error('Expected persistence result'); return value; }
function acquired(value: RenewalClaim): InstanceSnapshot {
  expect(value.kind).toBe('acquired'); if (value.kind !== 'acquired') throw new Error('Expected renewal reservation'); return value.snapshot;
}

async function setup(adapter: Adapter) {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-renewal-'));
  let store: Store; let reopen: () => Promise<void>;
  let rows: <T>(sql: string, ...values: (string | number | null)[]) => Promise<T[]>;
  if (adapter === 'SQLite') {
    const path = join(directory, 'state.sqlite'); let current = openSqlite(path); store = current;
    const inspect = new Database(path);
    rows = async <T>(sql: string, ...values: (string | number | null)[]) => inspect.query<T, (string | number | null)[]>(sql).all(...values);
    reopen = async () => { current.close(); current = openSqlite(path); store = current; };
    cleanups.push(async () => { current.close(); inspect.close(); await rm(directory, { recursive: true, force: true }); });
  } else {
    const options = { modules: true, script: 'export default {fetch(){return new Response("Renewal fixture")}}', compatibilityDate: '2026-07-30',
      d1Databases: { DB: 'renewal-tests' }, d1Persist: directory, log: new Log(LogLevel.ERROR) };
    let mf = new Miniflare(options); let db = await mf.getD1Database('DB') as unknown as D1Database;
    cleanups.push(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
    for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()).replace(/^\s*--.*$/gm, '').replaceAll('\n', ' '));
    }
    store = createD1Store(db);
    rows = async <T>(sql: string, ...values: (string | number | null)[]) => (await db.prepare(sql).bind(...values).all<T>()).results;
    reopen = async () => { await mf.dispose(); mf = new Miniflare(options); db = await mf.getD1Database('DB') as unknown as D1Database; store = createD1Store(db); };
  }
  const installation = await store.activate(manifest, 'old-revision', null);
  for (const id of ['a', 'b']) expect(await store.insert({ id, pluginId: manifest.id, name: `Instance ${id}`, config: { endpoint: id }, epoch: 1 },
    { credential: id }, installation)).toBe(true);
  return { get store() { return store; }, rows, reopen,
    async capture(id = 'a') { return present(await store.capture(id)); } };
}

for (const adapter of ['SQLite', 'D1'] as const) {
  test(`${adapter}: one atomic claim reserves a revision and fences old/new ordinary writes without blocking another instance`, async () => {
    const f = await setup(adapter); const now = Date.now(); const before = await f.capture();
    const clock = present((await f.rows<{ instant: number }>("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS instant"))[0]).instant;
    expect(clock).toBeGreaterThan(now - 5000); expect(clock).toBeLessThan(Date.now() + 5000);
    expect(await f.store.claimRenewal({ ...before, privateState: { incorrect: true } }, 'incorrect', now, now + 60_000)).toEqual({ kind: 'retry' });
    expect((await f.capture()).stateRevision).toBe(before.stateRevision);
    const claims = await Promise.all(['holder-one', 'holder-two'].map(token => f.store.claimRenewal(before, token, now, now + 60_000)));
    expect(claims.map(claim => claim.kind).sort()).toEqual(['acquired', 'busy']);
    const index = claims.findIndex(claim => claim.kind === 'acquired'); const token = ['holder-one', 'holder-two'][index]!;
    const reserved = acquired(claims[index]!);
    expect(reserved).toEqual({ ...before, stateRevision: before.stateRevision + 1 });
    expect(await f.store.saveState(before, { credential: 'obsolete-before-claim' })).toBe(false);
    expect(await f.store.saveState(await f.capture(), { credential: 'new-capture-during-renewal' })).toBe(false);
    const other = acquired(await f.store.claimRenewal(await f.capture('b'), 'other-instance', now, now + 60_000));
    expect(other.id).toBe('b'); expect(other.stateRevision).toBe(2);
    expect(await f.store.finishRenewal(reserved, token, { ok: true, value: null, nextPrivateState: { credential: 'renewed' } }, now + 1, 0)).toBe(true);
    const finished = await f.capture(); expect(finished.privateState).toEqual({ credential: 'renewed' });
    expect(finished.epoch).toBe(before.epoch); expect(finished.stateRevision).toBe(before.stateRevision + 2);
    expect(await f.store.finishRenewal(reserved, token, { ok: true, value: null, nextPrivateState: { obsolete: true } }, now + 2, 0)).toBe(false);
    await f.store.releaseRenewal('a', token);
    expect(await f.store.saveState(finished, { credential: 'ordinary-after-finish' })).toBe(true);
  }, 20_000);

  test(`${adapter}: lease and failure outcome survive restart, keep confirmed state, expire and cascade with the instance`, async () => {
    const f = await setup(adapter); const now = Date.now(); const before = await f.capture();
    const reserved = acquired(await f.store.claimRenewal(before, 'persistent-holder', now, now + 60_000));
    await f.reopen();
    expect(await f.capture()).toEqual(reserved);
    expect(await f.store.claimRenewal(before, 'waiter', now + 1, now + 60_000)).toEqual({ kind: 'busy', until: now + 60_000 });
    expect(await f.store.finishRenewal(reserved, 'persistent-holder', { ok: false, error: failure, nextPrivateState: { credential: 'renewed-before-failure' } }, now + 2, now + 2000)).toBe(true);
    const finished = await f.capture(); expect(finished.stateRevision).toBe(reserved.stateRevision + 1);
    expect(finished.privateState).toEqual({ credential: 'renewed-before-failure' });
    await f.store.releaseRenewal('a', 'persistent-holder'); await f.reopen();
    expect(await f.store.claimRenewal(before, 'joined-waiter', now + 3, now + 60_000)).toEqual({ kind: 'failed', error: failure });
    expect(await f.store.claimRenewal(finished, 'new-request', now + 1999, now + 60_000)).toEqual({ kind: 'failed', error: failure });
    const retry = acquired(await f.store.claimRenewal(finished, 'after-expiry', now + 2000, now + 60_000));
    expect(retry.stateRevision).toBe(finished.stateRevision + 1);
    expect(await f.store.finishRenewal(retry, 'after-expiry', { ok: false, error: failure }, now + 2001, now + 4000)).toBe(true);
    expect((await f.capture()).privateState).toEqual(finished.privateState);
    await f.store.deleteInstance('a'); expect(await f.rows('SELECT * FROM source_renewals')).toEqual([]);
    expect(await f.store.finishRenewal(retry, 'after-expiry', { ok: true, value: null }, now + 2002, 0)).toBe(false);
  }, 20_000);

  test(`${adapter}: an expired lease can be taken over and an old owner cannot finish or release the replacement`, async () => {
    const f = await setup(adapter); const now = Date.now();
    const old = acquired(await f.store.claimRenewal(await f.capture(), 'old-holder', now, now + 1000));
    expect(await f.store.claimRenewal(old, 'too-soon', now + 999, now + 60_000)).toEqual({ kind: 'busy', until: now + 1000 });
    const fresh = acquired(await f.store.claimRenewal(old, 'fresh-holder', now + 1000, now + 60_000));
    expect(fresh.stateRevision).toBe(old.stateRevision + 1);
    await f.store.releaseRenewal('a', 'old-holder');
    expect(await f.store.claimRenewal(fresh, 'observer', now + 1001, now + 60_000)).toEqual({ kind: 'busy', until: now + 60_000 });
    expect(await f.store.finishRenewal(old, 'old-holder', { ok: true, value: null, nextPrivateState: { credential: 'obsolete' } }, now + 1001, 0)).toBe(false);
    expect(await f.store.finishRenewal(fresh, 'fresh-holder', { ok: true, value: null }, now + 1002, 0)).toBe(true);
    expect((await f.capture()).privateState).toEqual({ credential: 'a' });
    expect((await f.capture()).stateRevision).toBe(fresh.stateRevision + 1);
    const released = acquired(await f.store.claimRenewal(await f.capture(), 'released-holder', now + 1003, now + 60_000));
    await f.store.releaseRenewal('a', 'released-holder');
    expect((await f.store.claimRenewal(released, 'after-release', now + 1004, now + 60_000)).kind).toBe('acquired');
    await f.store.releaseRenewal('a', 'after-release');
    const expiredAt = Date.now() - 1000;
    const expired = acquired(await f.store.claimRenewal(await f.capture(), 'already-expired', expiredAt - 1000, expiredAt));
    expect(await f.store.saveState(expired, { credential: 'ordinary-after-expiry' })).toBe(true);
  }, 20_000);

  test(`${adapter}: authentication epochs and plugin generations immediately supersede a live lease`, async () => {
    const f = await setup(adapter); const now = Date.now();
    const old = acquired(await f.store.claimRenewal(await f.capture(), 'before-authentication', now, now + 60_000));
    const next: AuthenticationRecord = { operationId: 'new-authentication', revision: 0, step: null,
      stamp: { id: old.id, pluginId: old.pluginId, epoch: old.epoch + 1, pluginRevision: old.pluginRevision, pluginGeneration: old.pluginGeneration } };
    expect(await f.store.advanceAuthentication(old, next)).toBe(true);
    expect(await f.store.claimRenewal(old, 'stale-source', now + 1, now + 60_000)).toEqual({ kind: 'retry' });
    const authenticated = await f.capture(); expect(authenticated.authentication).toEqual(next); expect(authenticated.epoch).toBe(old.epoch + 1);
    const authLease = acquired(await f.store.claimRenewal(authenticated, 'after-authentication', now + 1, now + 60_000));
    expect(await f.store.finishRenewal(old, 'before-authentication', { ok: true, value: null, nextPrivateState: { obsolete: true } }, now + 2, 0)).toBe(false);
    await f.store.activate({ ...manifest, version: '1.0.1' }, 'new-revision', 1);
    const installed = await f.capture(); expect(installed.pluginGeneration).toBe(2);
    const installedLease = acquired(await f.store.claimRenewal(installed, 'after-installation', now + 3, now + 60_000));
    await f.store.releaseRenewal('a', 'after-authentication');
    expect(await f.store.finishRenewal(authLease, 'after-authentication', { ok: false, error: failure }, now + 4, now + 2000)).toBe(false);
    expect(await f.store.claimRenewal(authLease, 'obsolete-observer', now + 4, now + 60_000)).toEqual({ kind: 'retry' });
    expect(await f.store.finishRenewal(installedLease, 'after-installation', { ok: true, value: null, nextPrivateState: { credential: 'latest' } }, now + 5, 0)).toBe(true);
    expect((await f.capture()).privateState).toEqual({ credential: 'latest' });
  }, 20_000);

  test(`${adapter}: a later ordinary state revision invalidates a cached failure`, async () => {
    const f = await setup(adapter); const now = Date.now();
    const reserved = acquired(await f.store.claimRenewal(await f.capture(), 'holder', now, now + 60_000));
    expect(await f.store.finishRenewal(reserved, 'holder', { ok: false, error: failure }, now + 1, now + 2000)).toBe(true);
    const failed = await f.capture(); expect(failed.stateRevision).toBe(reserved.stateRevision + 1);
    expect(await f.store.saveState(failed, { credential: 'changed-independently' })).toBe(true);
    expect(await f.store.claimRenewal(failed, 'obsolete-basis', now + 2, now + 60_000)).toEqual({ kind: 'retry' });
    expect((await f.store.claimRenewal(await f.capture(), 'fresh-basis', now + 2, now + 60_000)).kind).toBe('acquired');
  }, 20_000);
}
