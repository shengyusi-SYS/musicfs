import { expect, test } from 'bun:test';
import type { Context, Json } from '@musicfs/plugin-api';
import { createQqPlugin } from '../plugins/qq';
import { QqClient, type QqHandler, type QqState } from '../plugins/qq/client';
import { createSealedSessionResolver, deriveAndroidDevice } from '../plugins/qq/generated-upstream.mjs';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const handler: QqHandler = async () => json({ data: { profile: { nickname: 'fixture' } } });
async function fixture(loginType = 6, remaining = 3_600_000) {
  const secret = 'renewal-fixture-' + crypto.randomUUID();
  const credential = { musicid: '123', str_musicid: '123', musickey: 'private-old-key', loginType,
    refresh_key: 'private-refresh-key', refresh_token: 'private-refresh-token', openid: 'private-openid', encryptUin: 'encrypted-123' };
  const resolver = createSealedSessionResolver({ secrets: { current: secret } });
  const token = await resolver.issue({ credential, device: await deriveAndroidDevice(secret), expiresAt: Date.now() + remaining });
  const state: QqState = { version: 2, secret, token, accountName: 'fixture', pending: null, renewAfter: 0 };
  const calls: { body: { comm: { tmeLoginType: number }; req_0: { method: string; param: Record<string, unknown> } }; headers: Headers }[] = [];
  let responseStatus = 200; let businessCode = 0;
  const fetcher = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({ body, headers: new Headers(init?.headers) });
    if (body.req_0.method !== 'Login') return json({ code: 0, req_0: { code: 10006 } });
    return json({ code: 0, req_0: { code: businessCode, data: { ...credential, musickey: 'private-new-key',
      musickeyCreateTime: Math.floor(Date.now() / 1000), keyExpiresIn: 3 * 86_400 } } }, responseStatus);
  }) as typeof fetch;
  const controller = new AbortController();
  const ctx: Context = { instanceId: 'renewal-' + crypto.randomUUID(), config: { channel: loginType === 1 ? 'wechat' : 'qq' },
    privateState: state as Json, signal: controller.signal, fetch: fetcher };
  return { state, ctx, resolver, controller, calls, plugin: createQqPlugin(handler),
    fail(status: number, code = 0) { responseStatus = status; businessCode = code; } };
}

test('QQ state migration preserves the account and confirmed challenge without reissuing credentials', async () => {
  const f = await fixture(); const { renewAfter: _renewAfter, ...old } = f.state;
  const pending = { id: 'confirmed', key: 'private-qr', channel: 'qq' as const,
    expiresAt: new Date(Date.now() - 1).toISOString(), qrImage: 'data:image/png;base64,AA==', confirmed: true };
  const state = f.plugin.migrateState!({ fromVersion: 1, state: { ...old, version: 1, pending }, config: f.ctx.config });
  expect(state).toEqual({ ...f.state, pending });
  expect(f.plugin.validateState!({ config: f.ctx.config, state })).toBe(true);
  expect(f.plugin.validateState!({ config: f.ctx.config, state: { ...old, version: 1 } })).toBe(false);
  expect(f.plugin.validateState!({ config: f.ctx.config, state: { ...f.state, renewAfter: -1 } })).toBe(false);
  expect(f.calls).toHaveLength(0);
});

test('QQ checks renewal locally and skips fresh credentials or a persisted retry window', async () => {
  const fresh = await fixture(6, 3 * 86_400_000);
  expect(await fresh.plugin.renewal!.needed(fresh.ctx)).toBe(false);
  const due = await fixture();
  expect(await due.plugin.renewal!.needed(due.ctx)).toBe(true);
  due.ctx.privateState = { ...due.state, pending: { id: 'expired', key: 'unused', channel: 'qq', confirmed: false,
    expiresAt: new Date(Date.now() - 1).toISOString(), qrImage: 'data:image/png;base64,AA==' } };
  expect(await due.plugin.renewal!.needed(due.ctx)).toBe(true);
  due.ctx.privateState = { ...due.state, renewAfter: Date.now() + 300_000 };
  expect(await createQqPlugin(handler).renewal!.needed(due.ctx)).toBe(false);
  expect(fresh.calls).toHaveLength(0); expect(due.calls).toHaveLength(0);
});

test('QQ and WeChat renew through the pinned SDK and a restored client uses the new credential', async () => {
  for (const loginType of [6, 1]) {
    const f = await fixture(loginType); const before = Date.now();
    const renewed = await f.plugin.renewal!.renew(f.ctx);
    expect(renewed).toMatchObject({ ok: true, value: null });
    const state = renewed.nextPrivateState as QqState;
    expect(state.token).not.toBe(f.state.token); expect(state.secret).toBe(f.state.secret);
    expect(state.accountName).toBe('fixture'); expect(state.renewAfter).toBeGreaterThanOrEqual(before + 300_000);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.body.req_0.param).toMatchObject({ refresh_key: 'private-refresh-key', refresh_token: 'private-refresh-token' });
    expect(f.calls[0]!.body.comm.tmeLoginType).toBe(loginType);
    const restored = await f.resolver.resolve(state.token!);
    expect(restored?.credential.musickey).toBe('private-new-key'); expect(restored?.credential.loginType).toBe(loginType);
    expect(restored!.expiresAt).toBeGreaterThan(Date.now() + 2 * 86_400_000);
    f.ctx.privateState = state as Json;
    expect(await createQqPlugin(handler).renewal!.needed(f.ctx)).toBe(false);
    const businessFailure = await createQqPlugin(handler).list(f.ctx, 'favorites');
    expect(businessFailure).toMatchObject({ ok: false, error: { kind: 'temporary' } });
    expect(businessFailure.nextPrivateState).toBeUndefined();
    expect(f.calls.at(-1)!.headers.get('cookie')).toContain('private-new-key');
    expect((f.ctx.privateState as QqState).token).toBe(state.token);
  }
});

test('failed QQ renewal keeps the usable token and persists a retry window across new plugin instances', async () => {
  for (const [status, code] of [[503, 0], [200, 104400]] as const) {
    const f = await fixture(); f.fail(status, code);
    const outcome = await f.plugin.renewal!.renew(f.ctx);
    expect(outcome).toMatchObject({ ok: true, value: null, nextPrivateState: { token: f.state.token, accountName: 'fixture' } });
    f.ctx.privateState = outcome.nextPrivateState!;
    expect((f.ctx.privateState as QqState).renewAfter).toBeGreaterThan(Date.now());
    expect(await createQqPlugin(handler).renewal!.needed(f.ctx)).toBe(false);
    expect(f.calls).toHaveLength(1);
  }
});

test('QQ expired sessions and an explicitly unauthenticated profile clear the invalid private credential', async () => {
  const expired = await fixture(6, -1);
  expect(await expired.plugin.renewal!.needed(expired.ctx)).toBe(true);
  expect(await expired.plugin.renewal!.renew(expired.ctx)).toMatchObject({ ok: false, error: { kind: 'needs_auth' },
    nextPrivateState: { token: null, accountName: null, pending: null, renewAfter: 0 } });
  expect(expired.calls).toHaveLength(0);
  const restored = await fixture();
  expect(await createQqPlugin(async () => json({ data: {} })).roots(restored.ctx)).toMatchObject({ ok: false,
    error: { kind: 'needs_auth' }, nextPrivateState: { token: null, accountName: null } });
  const temporary = await createQqPlugin(async () => json({}, 502)).roots(restored.ctx);
  expect(temporary).toMatchObject({ ok: false, error: { kind: 'temporary' } });
  expect(temporary.nextPrivateState).toBeUndefined();
});

test('QQ old-session invalidation preserves the independent QR challenge and skips its renewal', async () => {
  const f = await fixture(); const pending = { id: 'replacement', key: 'private-new-qr', channel: 'qq' as const,
    expiresAt: new Date(Date.now() + 120_000).toISOString(), qrImage: 'data:image/png;base64,AA==', confirmed: false };
  f.ctx.privateState = { ...f.state, pending };
  expect(await f.plugin.renewal!.needed(f.ctx)).toBe(false);
  expect(await f.plugin.renewal!.renew(f.ctx)).toEqual({ ok: true, value: null });
  expect(await createQqPlugin(async () => json({ data: {} })).roots(f.ctx)).toMatchObject({ ok: false,
    error: { kind: 'needs_auth' }, nextPrivateState: { token: null, accountName: null, pending } });
  expect(f.calls).toHaveLength(0);
});

test('QQ renewal aborts its actual SDK fetch and does not return a state candidate after cancellation', async () => {
  const f = await fixture(); let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
  let cancelled = false;
  f.ctx.fetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { cancelled = true; reject(init!.signal!.reason); }, { once: true }); started();
  })) as typeof fetch;
  const work = f.plugin.renewal!.renew(f.ctx); await start;
  f.controller.abort(new Error('renewal-cancelled'));
  await expect(work).rejects.toThrow('renewal-cancelled'); expect(cancelled).toBe(true);
  expect(f.ctx.privateState).toEqual(f.state as Json);
});

test('QQ plugin locally restores a confirmed sealed credential without consuming its QR or inheriting an old account name', async () => {
  const f = await fixture(); const calls: string[] = [];
  f.ctx.privateState = { ...f.state, pending: { id: 'confirmed', key: 'private-consumed-qr', channel: 'qq',
    expiresAt: new Date(Date.now() - 1).toISOString(), qrImage: 'data:image/png;base64,AA==', confirmed: true } };
  const plugin = createQqPlugin(async request => { calls.push(new URL(request.url).pathname); return json({}, 502); });
  expect(await plugin.authenticate!(f.ctx, { kind: 'poll', challengeId: 'confirmed' })).toMatchObject({ ok: true,
    value: { kind: 'complete' }, nextPrivateState: { pending: null, token: f.state.token, accountName: null } });
  expect(calls).toEqual([]);
  f.ctx.privateState = { ...(f.ctx.privateState as QqState), token: null };
  expect(await plugin.authenticate!(f.ctx, { kind: 'poll', challengeId: 'confirmed' })).toMatchObject({ ok: false,
    error: { kind: 'needs_auth' }, nextPrivateState: { token: null, pending: null } });
  expect(calls).toEqual([]);
});

test('QQ recommendation client forwards caller cancellation independently of the catalogue wrapper', async () => {
  const f = await fixture(); let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
  let cancelled = false;
  f.ctx.fetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { cancelled = true; reject(init!.signal!.reason); }, { once: true }); started();
  })) as typeof fetch;
  const work = new QqClient(f.ctx, handler).recommendations(); await start;
  f.controller.abort(new Error('recommendation-cancelled'));
  await expect(work).rejects.toThrow('recommendation-cancelled'); expect(cancelled).toBe(true);
});
