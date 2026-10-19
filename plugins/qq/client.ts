import type { Context, Json, Outcome, PluginFault } from '@musicfs/plugin-api';
import type { handleRequest } from '@yakult-green-tea/qq-music-api/serverless';
import { z } from 'zod';
import { createSealedSessionResolver, createSessionMusicuClient, QqApiError, type AuthSession, type MusicuDescriptor } from './generated-upstream.mjs';

export type QqHandler = typeof handleRequest;
const pending = z.object({ id: z.string(), key: z.string(), channel: z.enum(['qq', 'wechat']), expiresAt: z.string(), qrImage: z.string(), confirmed: z.boolean() }).strict();
const saved = z.object({ version: z.literal(1), secret: z.string().min(32), token: z.string().nullable(), accountName: z.string().nullable(), pending: pending.nullable() }).strict();
export type QqState = z.infer<typeof saved>;
export const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
export class QqFailure extends Error {
  constructor(readonly fault: PluginFault) { super(fault.message); }
}
export function fail(kind: PluginFault['kind'], message: string): never { throw new QqFailure({ kind, message }); }

export class QqClient {
  state: QqState;
  changed = false;
  constructor(readonly ctx: Context, private readonly handler: QqHandler) {
    if (ctx.privateState === null) {
      this.state = { version: 1, secret: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''), token: null, accountName: null, pending: null };
      this.changed = true;
    } else {
      const parsed = saved.safeParse(ctx.privateState);
      if (!parsed.success) fail('invalid_config', 'QQ 插件的私有状态无法识别，请重新创建实例。');
      this.state = parsed.data;
    }
  }
  update(next: QqState) { this.state = next; this.changed = true; }
  private needsAuthentication(): never {
    this.update({ ...this.state, token: null, accountName: null });
    return fail('needs_auth', 'QQ 授权已失效，请重新扫码。');
  }
  /** Pinned SDK transport with caller cancellation; descriptors stay private to this plugin. */
  async rpc(describe: (session: AuthSession) => MusicuDescriptor): Promise<Record<string, unknown>> {
    return (await this.rpcBatch(session => [describe(session)]))[0]!;
  }
  async rpcBatch(describe: (session: AuthSession) => MusicuDescriptor[]): Promise<Record<string, unknown>[]> {
    this.requireSession(); this.ctx.signal.throwIfAborted();
    try {
      const resolver = createSealedSessionResolver({ secrets: { current: this.state.secret } });
      const session = await resolver.resolve(this.state.token!);
      if (!session) return this.needsAuthentication();
      const transport = createSessionMusicuClient(session, { fetcher: this.ctx.fetch, maxRetries: 0 });
      const results = await transport.executeBatch(describe(session), { signal: this.ctx.signal });
      const data = results.map(result => { if (!result.ok) throw result.error; return object(result.data); });
      this.ctx.signal.throwIfAborted(); return data;
    } catch (error) {
      this.ctx.signal.throwIfAborted();
      if (error instanceof QqFailure) throw error;
      if (error instanceof QqApiError) {
        if (error.kind === 'auth-missing' || error.kind === 'credential-invalid') return this.needsAuthentication();
        if (error.kind === 'not-found') fail('not_found', 'QQ 当前没有此项内容。');
        if (error.kind === 'rate-limited') throw new QqFailure({ kind: 'rate_limited', message: 'QQ 请求过于频繁，请稍后重试。',
          ...(error.retryAfterMs ? { retryAfterSeconds: Math.ceil(error.retryAfterMs / 1000) } : {}) });
      }
      return fail('temporary', 'QQ 内容请求暂时失败，请稍后重试。');
    }
  }
  async call(path: string, params: Record<string, string> = {}, method = 'GET'): Promise<Record<string, unknown>> {
    this.ctx.signal.throwIfAborted();
    const url = new URL(path, 'https://qq-plugin.musicfs.invalid');
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    const response = await this.handler(new Request(url, { method, signal: this.ctx.signal,
      headers: this.state.token ? { 'x-qq-session': this.state.token } : {} }), { QQ_SESSION_SECRET: this.state.secret });
    this.ctx.signal.throwIfAborted();
    if (!response.ok) {
      if (response.status === 422) {
        const body = object(await response.json().catch(() => null));
        if (body.errorKey === 'resource.not-found') fail('not_found', 'QQ 当前没有此项内容。');
      }
      await response.body?.cancel();
      if (response.status === 401) {
        return this.needsAuthentication();
      }
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        throw new QqFailure({ kind: 'rate_limited', message: 'QQ 请求过于频繁，请稍后重试。', ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterSeconds: seconds } : {}) });
      }
      fail('temporary', `QQ 请求暂未成功（HTTP ${response.status}），请稍后重试。`);
    }
    let data: unknown;
    try { data = await response.json(); } catch { fail('temporary', 'QQ 返回了无法识别的数据。'); }
    return object(data);
  }
  requireSession() { if (!this.state.token) fail('needs_auth', '请先为此 QQ 实例扫码授权。'); }
}

export async function run<T>(ctx: Context, handler: QqHandler, operation: (client: QqClient) => Promise<T>): Promise<Outcome<T>> {
  let client: QqClient | undefined;
  try {
    client = new QqClient(ctx, handler); const value = await operation(client); ctx.signal.throwIfAborted();
    return { ok: true, value, ...(client.changed ? { nextPrivateState: client.state as Json } : {}) };
  } catch (error) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    return { ok: false, error: error instanceof QqFailure ? error.fault : { kind: 'temporary', message: 'QQ 请求暂时失败，请稍后重试。' },
      ...(client?.changed ? { nextPrivateState: client.state as Json } : {}) };
  }
}
