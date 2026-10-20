import { expect, test } from 'bun:test';
import type { Context, Json } from '@musicfs/plugin-api';
import { createQqPlugin } from '../plugins/qq';
import type { QqState } from '../plugins/qq/client';
import { sealQrState } from '../plugins/qq/generated-upstream.mjs';
import { qqSession } from './helpers/qq-session';

async function fixture(channel: 'qq' | 'wechat' = 'qq') {
  const controller = new AbortController();
  const state = await qqSession() as QqState;
  const ctx: Context = { instanceId: 'authentication-cancellation', config: { channel }, privateState: state as Json,
    signal: controller.signal, fetch: (async (_input, _init) => Promise.reject<Response>(new Error('Unexpected network request'))) as typeof fetch };
  return { controller, state, ctx, plugin: createQqPlugin() };
}

function heldFetch(ctx: Context) {
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const requests: Request[] = [];
  let cancelled = false;
  ctx.fetch = (async (input, init) => {
    const request = new Request(input, init); requests.push(request);
    return new Promise<Response>((_resolve, reject) => {
      request.signal.throwIfAborted();
      request.signal.addEventListener('abort', () => { cancelled = true; reject(request.signal.reason); }, { once: true });
      start();
    });
  }) as typeof fetch;
  return { started, requests, cancelled: () => cancelled };
}

async function challenge(f: Awaited<ReturnType<typeof fixture>>, channel: 'qq' | 'wechat') {
  const now = Date.now();
  const key = await sealQrState({ channel, createdAt: now, expiresAt: now + 120_000,
    identifier: channel === 'qq' ? 'private-qrsig' : 'private-wechat-uuid',
    cookies: 'wx_session=old; cleared=present; untouched=kept', device: {},
    ...(channel === 'qq' ? { image: 'data:image/png;base64,AA==' } : {}) }, f.state.secret);
  f.ctx.privateState = { ...f.state, pending: { id: 'challenge', key, channel, confirmed: false,
    expiresAt: new Date(now + 120_000).toISOString(), qrImage: 'data:image/png;base64,AA==' } };
}

test('QQ authentication rejects an already cancelled invocation before sending any SDK request', async () => {
  const f = await fixture(); const held = heldFetch(f.ctx);
  f.controller.abort(new Error('already-cancelled'));
  await expect(f.plugin.authenticate!(f.ctx, { kind: 'start' })).rejects.toThrow('already-cancelled');
  expect(held.requests).toHaveLength(0);
  expect(f.ctx.privateState).toEqual(f.state as Json);
});

test('QQ authentication aborts the actual SDK bootstrap Fetch without publishing a challenge', async () => {
  const f = await fixture('wechat'); const held = heldFetch(f.ctx);
  const work = f.plugin.authenticate!(f.ctx, { kind: 'start' }); await held.started;
  f.controller.abort(new Error('bootstrap-cancelled'));
  await expect(work).rejects.toThrow('bootstrap-cancelled');
  expect(held.requests[0]!.url).toContain('api.tencentmusic.com/tme/trpc/proxy');
  expect(held.cancelled()).toBe(true); expect(held.requests).toHaveLength(1);
  expect(f.ctx.privateState).toEqual(f.state as Json);
});

test('QQ and WeChat SDK drivers abort their actual in-flight polls and preserve the saved challenge', async () => {
  for (const channel of ['qq', 'wechat'] as const) {
    const f = await fixture(channel); await challenge(f, channel);
    const before = structuredClone(f.ctx.privateState); const held = heldFetch(f.ctx);
    const work = f.plugin.authenticate!(f.ctx, { kind: 'poll', challengeId: 'challenge' }); await held.started;
    expect(held.requests[0]!.url).toContain(channel === 'qq' ? '/ptqrlogin?' : '/connect/l/qrconnect?');
    f.controller.abort(new Error(`${channel}-poll-cancelled`));
    await expect(work).rejects.toThrow(`${channel}-poll-cancelled`);
    expect(held.cancelled()).toBe(true); expect(held.requests).toHaveLength(1);
    expect(f.ctx.privateState).toEqual(before);
  }
});

test('QQ directory account status uses the injected SDK Fetch and cancellation cannot clear credentials', async () => {
  const f = await fixture(); const held = heldFetch(f.ctx);
  const work = f.plugin.roots(f.ctx); await held.started;
  expect(held.requests[0]!.url).toContain('u.y.qq.com');
  f.controller.abort(new Error('profile-cancelled'));
  await expect(work).rejects.toThrow('profile-cancelled');
  expect(held.cancelled()).toBe(true); expect(held.requests).toHaveLength(1);
  expect(f.ctx.privateState).toEqual(f.state as Json);
});

test('WeChat SDK polling restores sealed cookies and applies redirect cookie replacement and deletion', async () => {
  const f = await fixture('wechat'); await challenge(f, 'wechat');
  const requests: Request[] = [];
  f.ctx.fetch = (async (input, init) => {
    const request = new Request(input, init); requests.push(request);
    if (requests.length === 1) {
      const headers = new Headers({ location: 'https://lp.open.weixin.qq.com/connect/l/qrconnect?redirected=1' });
      headers.append('set-cookie', 'wx_session=new; Path=/');
      headers.append('set-cookie', 'cleared=; Max-Age=0; Path=/');
      return new Response(null, { status: 302, headers });
    }
    return new Response("window.wx_errcode=408;window.wx_code=''");
  }) as typeof fetch;
  expect(await f.plugin.authenticate!(f.ctx, { kind: 'poll', challengeId: 'challenge' })).toMatchObject({
    ok: true, value: { kind: 'waiting', challengeId: 'challenge' }
  });
  expect(requests).toHaveLength(2);
  expect(requests[0]!.headers.get('cookie')).toBe('wx_session=old; cleared=present; untouched=kept');
  expect(requests[1]!.headers.get('cookie')).toContain('wx_session=new');
  expect(requests[1]!.headers.get('cookie')).toContain('untouched=kept');
  expect(requests[1]!.headers.get('cookie')).not.toContain('cleared=');
  expect(requests.every(request => request.redirect === 'manual')).toBe(true);
});
