import type { Context, Json, Outcome, PluginFault } from '@musicfs/plugin-api';
import type { QqRequestHandler } from './upstream';
import { AudioTagError } from '@musicfs/audio-tags';
import { z } from 'zod';
import { AUTH_REFRESH_EARLY_MS, AUTH_REFRESH_RETRY_MS, createFetchTransport, createSealedSessionResolver, createSessionMusicuClient, refreshLoginCredential, recommendPlaylistsResult, QqApiError, type AuthHttpClient, type AuthSession, type MusicuDescriptor } from './generated-upstream.mjs';

export type QqHandler = QqRequestHandler;
const pending = z.object({ id: z.string(), key: z.string(), channel: z.enum(['qq', 'wechat']), expiresAt: z.string(), qrImage: z.string(), confirmed: z.boolean() }).strict();
const savedV1 = z.object({ version: z.literal(1), secret: z.string().min(32), token: z.string().nullable(), accountName: z.string().nullable(), pending: pending.nullable() }).strict();
const saved = savedV1.extend({ version: z.literal(2), renewAfter: z.number().int().nonnegative() }).strict();
export type QqState = z.infer<typeof saved>;
const activeChallenge = (state: QqState) => state.pending !== null
  && (state.pending.confirmed || Date.parse(state.pending.expiresAt) > Date.now());
export function migrateState(fromVersion: number, state: Json): Json {
  if (fromVersion !== 1) fail('invalid_config', 'QQ 插件不支持此私有状态版本。');
  const previous = savedV1.safeParse(state);
  if (!previous.success) fail('invalid_config', 'QQ 插件的私有状态无法识别。');
  return { ...previous.data, version: 2, renewAfter: 0 };
}
export const validateState = (state: Json): boolean => saved.safeParse(state).success;
export const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
export class QqFailure extends Error {
  constructor(readonly fault: PluginFault) { super(fault.message); }
}
export function fail(kind: PluginFault['kind'], message: string): never { throw new QqFailure({ kind, message }); }
export class QqRequestBudgetFailure extends QqFailure {
  constructor() { super({ kind: 'temporary', message: '本页 QQ 请求较多，暂未完成准备，请稍后重试。' }); }
}
/** One catalogue invocation owns its counter; SDK and CDN calls share this seam. */
export function catalogueContext(ctx: Context): Context {
  let requests = 0;
  return { ...ctx, fetch: (async (input, init) => {
    ctx.signal.throwIfAborted();
    if (requests >= 45) throw new QqRequestBudgetFailure();
    requests++;
    return ctx.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([ctx.signal, init.signal]) : ctx.signal });
  }) as typeof fetch };
}

/** Only the SDK renewal RPC uses this JSON POST adapter; login redirects remain SDK-owned. */
function renewalHttp(ctx: Context): AuthHttpClient {
  const transport = createFetchTransport(ctx.fetch);
  const request: AuthHttpClient['request'] = async <T>(config: Parameters<AuthHttpClient['request']>[0]) => {
    const result = await transport({ url: String(config.url), body: typeof config.data === 'string' ? config.data : JSON.stringify(config.data),
      headers: Object.fromEntries(Object.entries(config.headers ?? {}).map(([key, value]) => [key, String(value)])),
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]) });
    return { data: result.body as T, status: result.status, statusText: '', headers: {},
      config: config as Awaited<ReturnType<AuthHttpClient['request']>>['config'] };
  };
  return { getCookieHeader: () => '', request, post: (url, data, config = {}) => request({ ...config, url, data, method: 'POST' }) };
}

/** Local SDK resolution only; the host coordinates renewal separately from ordinary reads. */
export async function renewalNeeded(ctx: Context): Promise<boolean> {
  ctx.signal.throwIfAborted();
  const state = saved.safeParse(ctx.privateState);
  if (!state.success || !state.data.token || activeChallenge(state.data) || state.data.renewAfter > Date.now()) return false;
  const resolver = createSealedSessionResolver({ secrets: { current: state.data.secret } });
  const session = await resolver.resolve(state.data.token);
  ctx.signal.throwIfAborted();
  return !session || Date.now() > session.expiresAt - AUTH_REFRESH_EARLY_MS;
}

export class QqClient {
  state: QqState;
  changed = false;
  private sessionPromise?: Promise<AuthSession>;
  constructor(readonly ctx: Context, private readonly handler: QqHandler) {
    if (ctx.privateState === null) {
      this.state = { version: 2, secret: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''), token: null, accountName: null, pending: null, renewAfter: 0 };
      this.changed = true;
    } else {
      const parsed = saved.safeParse(ctx.privateState);
      if (!parsed.success) fail('invalid_config', 'QQ 插件的私有状态无法识别，请重新创建实例。');
      this.state = parsed.data;
    }
  }
  update(next: QqState) { if (next.token !== this.state.token) delete this.sessionPromise; this.state = next; this.changed = true; }
  needsAuthentication(): never {
    this.update({ ...this.state, token: null, accountName: null, renewAfter: 0 });
    return fail('needs_auth', 'QQ 授权已失效，请重新扫码。');
  }
  async renew(): Promise<null> {
    if (!this.state.token || activeChallenge(this.state)) return null;
    this.ctx.signal.throwIfAborted();
    const resolver = createSealedSessionResolver({ secrets: { current: this.state.secret } });
    const rotation = await resolver.rotate!(this.state.token, session => refreshLoginCredential(renewalHttp(this.ctx), session.device, session.credential));
    // The SDK keeps the old token on a transient failure, including a cancelled fetch.
    this.ctx.signal.throwIfAborted();
    if (!rotation) return this.needsAuthentication();
    this.update({ ...this.state, token: rotation.token, renewAfter: Date.now() + AUTH_REFRESH_RETRY_MS });
    return null;
  }
  private session(): Promise<AuthSession> {
    this.requireSession();
    return this.sessionPromise ??= (async () => {
      const resolver = createSealedSessionResolver({ secrets: { current: this.state.secret } });
      return await resolver.resolve(this.state.token!) ?? this.needsAuthentication();
    })();
  }
  /** Pinned SDK transport with caller cancellation; descriptors stay private to this plugin. */
  async rpc(describe: (session: AuthSession) => MusicuDescriptor): Promise<Record<string, unknown>> {
    return (await this.rpcBatch(session => [describe(session)]))[0]!;
  }
  async rpcBatch(describe: (session: AuthSession) => MusicuDescriptor[]): Promise<Record<string, unknown>[]> {
    this.requireSession(); this.ctx.signal.throwIfAborted();
    try {
      const session = await this.session();
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
      headers: this.state.token ? { 'x-qq-session': this.state.token } : {} }), { QQ_SESSION_SECRET: this.state.secret },
    { fetch: this.ctx.fetch, signal: this.ctx.signal });
    return this.readResponse(response);
  }
  async recommendations(): Promise<Record<string, unknown>> {
    const result = await recommendPlaylistsResult(await this.session(), 25, { fetcher: (input, init) => this.ctx.fetch(input, {
      ...init, signal: init?.signal ? AbortSignal.any([this.ctx.signal, init.signal]) : this.ctx.signal }), maxRetries: 0 });
    return this.readResponse(new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers }));
  }
  private async readResponse(response: Response): Promise<Record<string, unknown>> {
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
    return { ok: false, error: error instanceof QqFailure ? error.fault : error instanceof AudioTagError ? { kind: error.kind, message: error.message } : { kind: 'temporary', message: 'QQ 请求暂时失败，请稍后重试。' },
      ...(client?.changed ? { nextPrivateState: client.state as Json } : {}) };
  }
}
