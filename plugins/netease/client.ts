import type { Context, Json, Outcome, PluginFault } from '@musicfs/plugin-api';
import { CookieJar, type SerializedCookieJar } from 'tough-cookie';
import { z } from 'zod';
import { encrypt, endpoints, type Endpoint, type UpstreamRequest } from './generated-upstream.mjs';

const pending = z.object({ id: z.string(), key: z.string(), expiresAt: z.string(), confirmed: z.boolean() }).strict();
const saved = z.object({ version: z.literal(1), cookies: z.string(), accountId: z.string().nullable(), accountName: z.string().nullable(), pending: pending.nullable() }).strict();
export type NeteaseState = z.infer<typeof saved>;
export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export class NeteaseFailure extends Error { constructor(readonly fault: PluginFault) { super(fault.message); } }
export function fail(kind: PluginFault['kind'], message: string): never { throw new NeteaseFailure({ kind, message }); }
const site = 'https://music.163.com';
const api = 'https://interface.music.163.com';
const ua = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152';

/** Each invocation owns its jar; only returned state proposals can reach host persistence. */
export class NeteaseClient {
  state: NeteaseState;
  changed = false;
  readonly jar: CookieJar;
  constructor(readonly ctx: Context) {
    if (ctx.privateState === null) {
      this.jar = new CookieJar();
      const device = crypto.randomUUID().replaceAll('-', '');
      for (const [name, value] of Object.entries({ deviceId: device, os: 'pc', appver: '3.1.17.204416', osver: 'Microsoft-Windows-10-Professional-build-19045-64bit', channel: 'netease', __remember_me: 'true' })) {
        this.jar.setCookieSync(`${name}=${value}; Domain=.music.163.com; Path=/`, site);
      }
      this.state = { version: 1, cookies: JSON.stringify(this.jar.serializeSync()), accountId: null, accountName: null, pending: null };
      this.changed = true;
    } else {
      const state = saved.safeParse(ctx.privateState);
      if (!state.success) fail('invalid_config', '网易云插件的私有状态无法识别，请重新创建实例。');
      this.state = state.data;
      try { this.jar = CookieJar.deserializeSync(JSON.parse(this.state.cookies) as SerializedCookieJar); }
      catch { fail('invalid_config', '网易云实例的 Cookie 状态无法恢复。'); }
    }
  }
  update(next: NeteaseState) { this.state = next; this.changed = true; }
  requireSession() {
    if (!this.jar.getCookiesSync(site).some(cookie => cookie.key === 'MUSIC_U' && cookie.value)) this.loseSession();
  }
  loseSession(): never {
    // Each invocation uses tough-cookie's default synchronous in-memory store.
    this.jar.store.getAllCookies((error, cookies) => {
      if (error) throw error;
      for (const cookie of cookies ?? []) if (cookie.key === 'MUSIC_U') this.jar.store.removeCookie(cookie.domain, cookie.path, cookie.key, error => { if (error) throw error; });
    });
    this.update({ ...this.state, cookies: JSON.stringify(this.jar.serializeSync()), accountId: null, accountName: null });
    return fail('needs_auth', '网易云授权已失效，请重新扫码。');
  }
  readonly request: UpstreamRequest = async (uri, data, options) => {
    this.ctx.signal.throwIfAborted();
    if (!uri.startsWith('/api/')) fail('not_supported', '上游模块返回了不支持的请求路径。');
    const mode = options.crypto || 'eapi';
    if (mode !== 'eapi' && mode !== 'weapi') fail('not_supported', '当前网易云请求模式不受支持。');
    const origin = mode === 'weapi' ? site : api;
    const cookies = Object.fromEntries(this.jar.getCookiesSync(origin).map(cookie => [cookie.key, cookie.value]));
    const payload: Record<string, unknown> = { ...data, e_r: false };
    const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': ua, Referer: `${site}/` });
    if (mode === 'weapi') payload.csrf_token = cookies.__csrf ?? '';
    else payload.header = { os: cookies.os ?? 'pc', osver: cookies.osver ?? '', appver: cookies.appver ?? '3.1.17.204416', deviceId: cookies.deviceId ?? '',
      versioncode: '140', mobilename: '', buildver: String(Math.floor(Date.now() / 1000)), resolution: '1920x1080', channel: cookies.channel ?? 'netease',
      __csrf: cookies.__csrf ?? '', requestId: `${Date.now()}_${crypto.getRandomValues(new Uint16Array(1))[0]}`, ...(cookies.MUSIC_U ? { MUSIC_U: cookies.MUSIC_U } : {}), ...(cookies.MUSIC_A ? { MUSIC_A: cookies.MUSIC_A } : {}) };
    const cookieHeader = this.jar.getCookieStringSync(origin);
    if (cookieHeader) headers.set('Cookie', cookieHeader);
    const url = `${origin}/${mode}/${uri.slice(5)}`;
    const body = new URLSearchParams(mode === 'weapi' ? encrypt.weapi(payload) : encrypt.eapi(uri, payload));
    const response = await this.ctx.fetch(url, { method: 'POST', headers, body, signal: this.ctx.signal });
    const received = response.headers.getSetCookie();
    for (const cookie of received) {
      try { this.jar.setCookieSync(cookie, url); }
      catch { await response.body?.cancel(); fail('temporary', '网易云返回了无法保存的 Cookie。'); }
    }
    if (received.length) this.update({ ...this.state, cookies: JSON.stringify(this.jar.serializeSync()) });
    if (response.status === 429) { await response.body?.cancel(); throw new NeteaseFailure({ kind: 'rate_limited', message: '网易云请求过于频繁，请稍后重试。' }); }
    if (!response.ok) { await response.body?.cancel(); fail('temporary', `网易云请求暂未成功（HTTP ${response.status}）。`); }
    let value: unknown;
    try { value = await response.json(); }
    catch { fail('temporary', '网易云返回了无法识别的内容。'); }
    this.ctx.signal.throwIfAborted();
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('temporary', '网易云返回了无法识别的数据。');
    return { status: response.status, body: object(value), cookie: received };
  };
  async call(endpoint: Endpoint, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const response = await endpoint({ ...params }, this.request);
    this.ctx.signal.throwIfAborted();
    const code = response.body.code;
    if (code === 301 || code === 302) return this.loseSession();
    if (code === 429) fail('rate_limited', '网易云请求过于频繁，请稍后重试。');
    if (code !== undefined && code !== 200 && code !== 800 && code !== 801 && code !== 802 && code !== 803) fail(code === 404 ? 'not_found' : 'temporary', '网易云暂时无法返回此项内容。');
    return response.body;
  }
  async profile(): Promise<{ id: string; name: string }> {
    const response = await this.call(endpoints.status);
    const data = object(response.data);
    if (data.profile === null) return this.loseSession();
    const profile = object(data.profile);
    const id = String(profile.userId ?? '');
    if (!/^[1-9]\d*$/.test(id) || typeof profile.userId === 'number' && !Number.isSafeInteger(profile.userId)) fail('temporary', '网易云暂未返回有效账号信息，请稍后重试。');
    const name = typeof profile.nickname === 'string' ? profile.nickname.slice(0, 500) : '网易云账号';
    if (this.state.accountId !== id || this.state.accountName !== name) this.update({ ...this.state, accountId: id, accountName: name });
    return { id, name };
  }
}

export async function run<T>(ctx: Context, operation: (client: NeteaseClient) => Promise<T>): Promise<Outcome<T>> {
  let client: NeteaseClient | undefined;
  try {
    client = new NeteaseClient(ctx); const value = await operation(client); ctx.signal.throwIfAborted();
    return { ok: true, value, ...(client.changed ? { nextPrivateState: client.state as Json } : {}) };
  } catch (error) {
    ctx.signal.throwIfAborted();
    return { ok: false, error: error instanceof NeteaseFailure ? error.fault : { kind: 'temporary', message: '网易云请求暂时失败，请稍后重试。' },
      ...(client?.changed ? { nextPrivateState: client.state as Json } : {}) };
  }
}
