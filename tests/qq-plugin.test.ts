import { expect, test } from 'bun:test';
import type { Context, Json, Outcome, AuthStep } from '@musicfs/plugin-api';
import { createQqPlugin } from '../plugins/qq';
import type { QqHandler } from '../plugins/qq/client';
import { parseManifest } from '../src/core/extensions';
import manifest from '../plugins/qq/manifest.json';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzEAAAAASUVORK5CYII=';
const context = (privateState: Json = null, instanceId = 'instance-a'): Context => ({ instanceId, config: { label: 'QQ', channel: 'qq' }, privateState, signal: new AbortController().signal, fetch });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function fixture() {
  const calls: { path: string; token: string | null; secret: string | undefined; query: URLSearchParams }[] = [];
  let profileUnavailable = false;
  const handler: QqHandler = async (request, env) => {
    const url = new URL(request.url); calls.push({ path: url.pathname, token: request.headers.get('x-qq-session'), secret: env?.QQ_SESSION_SECRET, query: url.searchParams });
    if (url.pathname === '/login/qr/key') return response({ code: 200, data: { unikey: 'private-sealed-qr-key' } });
    if (url.pathname === '/login/qr/create') return response({ code: 200, data: { qrimg: png } });
    if (url.pathname === '/login/qr/check') return response({ code: 803, cookie: 'qqmusic_session=private-sealed-session-token' });
    if (url.pathname === '/login/status') return profileUnavailable ? response({}, 502) : response({ code: 200, data: { profile: { nickname: '契约测试账号' } } });
    if (url.pathname === '/login/qr/cancel') return response({ code: 200 });
    return response({}, 404);
  };
  return { plugin: createQqPlugin(handler), calls, setProfileUnavailable(value: boolean) { profileUnavailable = value; } };
}
function value<T>(outcome: Outcome<T>): T { if (!outcome.ok) throw new Error(outcome.error.message); return outcome.value; }
function pending(step: AuthStep) { if (step.kind !== 'waiting') throw new Error('Expected QR step'); return step; }

test('QQ configuration creates independent stable private secrets and rejects source settings outside its schema', async () => {
  const { plugin } = fixture();
  const first = await plugin.validateConfig(context(), {}); const second = await plugin.validateConfig(context(null, 'instance-b'), {});
  expect(value(first)).toEqual({ label: 'QQ 音乐', channel: 'qq', audio: { mode: 'single', qualities: ['128'], missingQuality: 'hide' } });
  expect(first.nextPrivateState).not.toEqual(second.nextPrivateState);
  const modified = await plugin.validateConfig(context(first.nextPrivateState!), { label: '另一个名字', channel: 'wechat' });
  expect(modified.nextPrivateState ?? first.nextPrivateState).toEqual(first.nextPrivateState);
  expect(await plugin.validateConfig(context(), { secret: 'must-not-be-config' })).toMatchObject({ ok: false, error: { kind: 'invalid_config' } });
});

test('QQ uses an in-process SDK, keeps sealed keys private and adopts a confirmed session', async () => {
  const { plugin, calls } = fixture(); const ctx = context();
  const initial = await plugin.validateConfig(ctx, {}); ctx.privateState = initial.nextPrivateState!;
  const start = await plugin.authenticate!(ctx, { kind: 'start' }); const step = pending(value(start));
  expect(step.qrImage).toBe(png); expect(step.challengeId).not.toBe('private-sealed-qr-key');
  expect(JSON.stringify(step)).not.toContain('sealed'); ctx.privateState = start.nextPrivateState!;
  const complete = await plugin.authenticate!(ctx, { kind: 'poll', challengeId: step.challengeId });
  expect(value(complete)).toEqual({ kind: 'complete', accountName: '契约测试账号' });
  expect(JSON.stringify(value(complete))).not.toContain('token'); expect(JSON.stringify(complete.nextPrivateState)).toContain('private-sealed-session-token');
  expect(calls.map(call => call.path)).toEqual(['/login/qr/key', '/login/qr/create', '/login/qr/check', '/login/status']);
  expect(new Set(calls.map(call => call.secret)).size).toBe(1); expect(calls.at(-1)?.token).toBe('private-sealed-session-token');
});

test('a temporary profile failure preserves the exchanged credential and resumes without reusing an already consumed QR', async () => {
  const { plugin, calls, setProfileUnavailable } = fixture(); const ctx = context();
  const start = await plugin.authenticate!(ctx, { kind: 'start' }); const step = pending(value(start)); ctx.privateState = start.nextPrivateState!;
  setProfileUnavailable(true); const firstPoll = await plugin.authenticate!(ctx, { kind: 'poll', challengeId: step.challengeId });
  expect(firstPoll).toMatchObject({ ok: false, error: { kind: 'temporary' } }); ctx.privateState = firstPoll.nextPrivateState!;
  expect(JSON.stringify(ctx.privateState)).toContain('private-sealed-session-token');
  setProfileUnavailable(false); expect(value(await plugin.authenticate!(ctx, { kind: 'poll', challengeId: step.challengeId })).kind).toBe('complete');
  expect(calls.filter(call => call.path === '/login/qr/check')).toHaveLength(1);
});

test('QQ cancellation discards the private challenge and cannot be resumed through another instance state', async () => {
  const { plugin } = fixture(); const ctx = context();
  const start = await plugin.authenticate!(ctx, { kind: 'start' }); const step = pending(value(start)); ctx.privateState = start.nextPrivateState!;
  expect(value(await plugin.authenticate!(ctx, { kind: 'cancel', challengeId: step.challengeId })).kind).toBe('cancelled');
  expect(await plugin.authenticate!(context(null, 'other'), { kind: 'poll', challengeId: step.challengeId })).toMatchObject({ ok: false, error: { kind: 'invalid_config' } });
});

test('QQ declares the public contract needed by host-coordinated renewal and its migrated state', () => {
  expect(parseManifest(manifest, 'worker').apiRange).toBe('>=0.1.5 <0.2.0');
  expect(parseManifest(manifest, 'worker').stateVersion).toBe(2);
});
