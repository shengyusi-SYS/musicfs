import { afterEach, expect, test } from 'bun:test';
import type { Context, Outcome, PluginFault, SourcePlugin } from '@musicfs/plugin-api';
import { parseManifest, type PluginRegistry } from '../src/core/extensions';
import { createSources, type RenewalClaim, type RenewalStore } from '../src/core/sources';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import manifest from '../plugins/sample/manifest.json';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const gate = <T>() => Promise.withResolvers<T>();
const signal = () => new AbortController().signal;
const rootsPage = { items: [] };
const file = { contentId: 'fixture', size: 4, mediaType: 'audio/wav' };
const token = (ctx: Context) => (ctx.privateState as { token: string }).token;
const unsupported = async (): Promise<Outcome<never>> => ({ ok: false, error: { kind: 'not_supported', message: 'Unused in renewal fixture' } });

async function setup(overrides: Partial<SourcePlugin> = {}) {
  const db = openSqlite(':memory:'); cleanups.push(db.close);
  const parsed = parseManifest(manifest, 'desktop'); db.activate(parsed, 'a'.repeat(64), null);
  const module: SourcePlugin = {
    configuration: { schema: { type: 'object' } },
    validateConfig: async (ctx, config) => ({ ok: true, value: config, ...(ctx.privateState === null ? { nextPrivateState: { token: 'old' } } : {}) }),
    roots: async () => ({ ok: true, value: rootsPage }), list: unsupported,
    stat: async () => ({ ok: true, value: file }), open: unsupported, ...overrides
  };
  const observations: { claims: number; onClaim?: (claim: RenewalClaim) => void } = { claims: 0 };
  const store = {
    ...db,
    async claimRenewal(...args: Parameters<RenewalStore['claimRenewal']>) {
      observations.claims++; const result = await db.claimRenewal(...args); observations.onClaim?.(result); return result;
    }
  };
  const registry: PluginRegistry = {
    async get(id) { const installed = db.installation(id); if (!installed) throw new Error('Missing fixture installation'); return { ...installed, module }; },
    async isCurrent(id, revision, generation) { const installed = db.installation(id); return installed?.status === 'active' && installed.revision === revision && installed.generation === generation; }
  };
  const sources = createSources(store, registry);
  const created = await sources.create(manifest.id, 'renewal fixture', { label: 'before' }, signal());
  if (!created.ok) throw new Error('Fixture creation failed');
  return { db, store, registry, module, observations, sources, id: created.value.id, another: () => createSources(store, registry) };
}

test('sources without necessary renewal do not claim a lease and ordinary business calls remain concurrent', async () => {
  for (const withPolicy of [false, true]) {
    const rootsEntered = gate<void>(); const statEntered = gate<void>(); const release = gate<void>(); let renewals = 0;
    const f = await setup({
      ...(withPolicy ? { renewal: { needed: async () => false, renew: async () => { renewals++; return { ok: true as const, value: null }; } } } : {}),
      roots: async () => { rootsEntered.resolve(); await release.promise; return { ok: true, value: rootsPage }; },
      stat: async () => { statEntered.resolve(); await release.promise; return { ok: true, value: file }; }
    });
    const roots = f.sources.roots(f.id, signal()); await rootsEntered.promise;
    const stat = f.another().stat(f.id, 'file', signal()); await statEntered.promise;
    expect(f.observations.claims).toBe(0); expect(renewals).toBe(0);
    release.resolve(); expect((await roots).ok).toBe(true); expect((await stat).ok).toBe(true);
  }
});

test('separate source services share one renewal and its reserved revision fences an older full-state proposal', async () => {
  const ordinaryEntered = gate<void>(); const finishOrdinary = gate<void>();
  const renewalEntered = gate<void>(); const finishRenewal = gate<void>(); const waiterEntered = gate<void>();
  let due = false; let renewals = 0; let rootCalls = 0; const businessTokens: string[] = [];
  const f = await setup({
    renewal: {
      needed: async ctx => due && token(ctx) === 'old',
      renew: async () => { renewals++; renewalEntered.resolve(); await finishRenewal.promise; return { ok: true, value: null, nextPrivateState: { token: 'new' } }; }
    },
    roots: async ctx => {
      if (++rootCalls === 1) { ordinaryEntered.resolve(); await finishOrdinary.promise; return { ok: true, value: rootsPage, nextPrivateState: { token: 'obsolete' } }; }
      businessTokens.push(token(ctx)); return { ok: true, value: rootsPage };
    },
    stat: async ctx => { businessTokens.push(token(ctx)); return { ok: true, value: file }; }
  });
  f.observations.onClaim = result => { if (result.kind === 'busy') waiterEntered.resolve(); };
  const before = f.db.capture(f.id)!;
  const ordinary = f.sources.roots(f.id, signal()); await ordinaryEntered.promise; due = true;
  const roots = f.sources.roots(f.id, signal()); await renewalEntered.promise;
  const stat = f.another().stat(f.id, 'file', signal()); await waiterEntered.promise;
  finishOrdinary.resolve(); await expect(ordinary).rejects.toMatchObject({ code: 'stale_call' });
  expect(f.db.capture(f.id)?.privateState).toEqual({ token: 'old' });
  finishRenewal.resolve(); expect((await roots).ok).toBe(true); expect((await stat).ok).toBe(true);
  expect(renewals).toBe(1); expect(businessTokens).toEqual(['new', 'new']);
  expect(f.db.capture(f.id)?.privateState).toEqual({ token: 'new' }); expect(f.db.capture(f.id)?.epoch).toBe(before.epoch);
});

test('a completed renewal stays persisted when subsequent business fails without advancing the source epoch', async () => {
  let renewals = 0; let businessCalls = 0;
  const fault: PluginFault = { kind: 'temporary', message: 'Fixture catalog is temporarily unavailable' };
  const f = await setup({
    renewal: { needed: ctx => token(ctx) === 'old', renew: async () => { renewals++; return { ok: true, value: null, nextPrivateState: { token: 'new' } }; } },
    roots: async ctx => { businessCalls++; expect(token(ctx)).toBe('new'); return { ok: false, error: fault }; }
  });
  const before = f.db.capture(f.id)!;
  expect(await f.sources.roots(f.id, signal())).toEqual({ ok: false, error: fault });
  expect(f.db.capture(f.id)?.privateState).toEqual({ token: 'new' }); expect(f.db.capture(f.id)?.epoch).toBe(before.epoch);
  expect(await f.another().roots(f.id, signal())).toEqual({ ok: false, error: fault });
  expect(renewals).toBe(1); expect(businessCalls).toBe(2);
});

test('a failed renewal is shared with waiting calls and a newly created service instead of repeated per caller', async () => {
  const entered = gate<void>(); const finish = gate<void>(); const waiterEntered = gate<void>(); let renewals = 0; let businessCalls = 0;
  const fault: PluginFault = { kind: 'temporary', message: 'Fixture renewal is temporarily unavailable', retryAfterSeconds: 10 };
  const f = await setup({
    renewal: {
      needed: () => true,
      renew: async () => { renewals++; entered.resolve(); await finish.promise; return { ok: false, error: fault, nextPrivateState: { token: 'replacement-from-error' } }; }
    },
    roots: async () => { businessCalls++; return { ok: true, value: rootsPage }; },
    stat: async () => { businessCalls++; return { ok: true, value: file }; }
  });
  f.observations.onClaim = result => { if (result.kind === 'busy') waiterEntered.resolve(); };
  const roots = f.sources.roots(f.id, signal()); await entered.promise;
  const stat = f.another().stat(f.id, 'file', signal()); await waiterEntered.promise; finish.resolve();
  expect(await roots).toEqual({ ok: false, error: fault }); expect(await stat).toEqual({ ok: false, error: fault });
  expect(await f.another().roots(f.id, signal())).toEqual({ ok: false, error: fault });
  expect(renewals).toBe(1); expect(businessCalls).toBe(0); expect(f.db.capture(f.id)?.privateState).toEqual({ token: 'replacement-from-error' });
});

test('cancelling one renewal waiter leaves its leader running and another instance can read immediately', async () => {
  const entered = gate<void>(); const finish = gate<void>(); const waiterEntered = gate<void>();
  let protectedId = ''; let renewalSignal: AbortSignal | undefined; const businessIds: string[] = [];
  const f = await setup({
    renewal: {
      needed: ctx => ctx.instanceId === protectedId && token(ctx) === 'old',
      renew: async ctx => { renewalSignal = ctx.signal; entered.resolve(); await finish.promise; return { ok: true, value: null, nextPrivateState: { token: 'new' } }; }
    },
    roots: async ctx => { businessIds.push(ctx.instanceId); return { ok: true, value: rootsPage }; }
  });
  protectedId = f.id;
  const other = await f.sources.create(manifest.id, 'independent fixture', {}, signal()); if (!other.ok) throw new Error('Fixture creation failed');
  f.observations.onClaim = result => { if (result.kind === 'busy') waiterEntered.resolve(); };
  const leader = f.sources.roots(f.id, signal()); await entered.promise;
  const controller = new AbortController(); const waiter = f.another().stat(f.id, 'file', controller.signal); await waiterEntered.promise;
  const reason = new Error('Fixture waiter cancelled'); controller.abort(reason); await expect(waiter).rejects.toBe(reason);
  expect(renewalSignal?.aborted).toBe(false);
  expect((await f.another().roots(other.value.id, signal())).ok).toBe(true); expect(businessIds).toEqual([other.value.id]);
  finish.resolve(); expect((await leader).ok).toBe(true); expect(f.db.capture(f.id)?.privateState).toEqual({ token: 'new' });
});

test('a configuration epoch change prevents a slow renewal from restoring the previous credential', async () => {
  const entered = gate<void>(); const finish = gate<void>(); let businessCalls = 0;
  const f = await setup({
    renewal: {
      needed: ctx => token(ctx) === 'old',
      renew: async () => { entered.resolve(); await finish.promise; return { ok: true, value: null, nextPrivateState: { token: 'obsolete-renewal' } }; }
    },
    roots: async () => { businessCalls++; return { ok: true, value: rootsPage }; }
  });
  const before = f.db.capture(f.id)!; const roots = f.sources.roots(f.id, signal()); await entered.promise;
  f.module.validateConfig = async (_ctx, config) => ({ ok: true, value: config, nextPrivateState: { token: 'configured' } });
  expect((await f.another().configure(f.id, { label: 'after' }, signal())).ok).toBe(true);
  finish.resolve(); await expect(roots).rejects.toMatchObject({ code: 'stale_call' });
  expect(businessCalls).toBe(0); expect(f.db.capture(f.id)).toMatchObject({ config: { label: 'after' }, privateState: { token: 'configured' }, epoch: before.epoch + 1 });
});
