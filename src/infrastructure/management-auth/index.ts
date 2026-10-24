import { betterAuth } from 'better-auth';
import type { BetterAuthOptions, GenericEndpointContext } from 'better-auth';
import { createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import { deleteSessionCookie, setSessionCookie } from 'better-auth/cookies';
import { constantTimeEqual, generateRandomString } from 'better-auth/crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ManagementAccess, ManagementTicket } from '../../contracts/management-auth';
import { getLogger } from '@logtape/logtape';
import { errorFields } from '../logging';

export { MANAGEMENT_AUTH_SCHEMA_SQL } from './schema';

const ADMIN_ID = 'musicfs-administrator';
const ADMIN_EMAIL = 'administrator@musicfs.internal';
const TICKET_TTL_MS = 3 * 60_000;
const username = z.string().trim().min(1).max(64);
const password = z.string().min(8).max(128);

export type ManagementAuthOptions = {
  database: NonNullable<BetterAuthOptions['database']>;
  adminToken: string;
  /** Separates cookies for local instances sharing 127.0.0.1 but different data folders. */
  instanceId?: string;
  host?: 'desktop' | 'worker';
};

export type ManagementAuth = ReturnType<typeof createManagementAuth>;

/** One administrator, with Better Auth owning password hashes, sessions, cookies and tickets. */
export function createManagementAuth(options: ManagementAuthOptions) {
  if (!options.adminToken) throw new Error('Management credential is required');
  const sessionSecret = createHash('sha256').update(`MusicFS management session\0${options.adminToken}`).digest('hex');
  const hasBearer = (headers: Headers) => {
    const value = headers.get('authorization');
    return value?.startsWith('Bearer ') === true && constantTimeEqual(value.slice(7), options.adminToken);
  };
  async function administrator(ctx: GenericEndpointContext) {
    const existing = await ctx.context.internalAdapter.findUserById(ADMIN_ID);
    if (existing) return existing;
    try {
      return await ctx.context.internalAdapter.createUser({ id: ADMIN_ID, name: 'admin', email: ADMIN_EMAIL, emailVerified: true }, { method: 'admin' });
    } catch (error) {
      // The unique singleton key also handles two first launches reaching D1 together.
      const created = await ctx.context.internalAdapter.findUserById(ADMIN_ID);
      if (created) return created;
      throw error;
    }
  }
  async function authorize(ctx: GenericEndpointContext) {
    if (hasBearer(ctx.headers ?? new Headers())) return;
    const session = await getSessionFromCtx(ctx);
    if (!session || session.user.id !== ADMIN_ID) throw ctx.error('UNAUTHORIZED', { message: '请先登录' });
  }
  async function signIn(ctx: GenericEndpointContext, rememberMe = true) {
    const user = await administrator(ctx);
    const session = await ctx.context.internalAdapter.createSession(user.id, !rememberMe);
    if (!session) throw ctx.error('INTERNAL_SERVER_ERROR', { message: '无法创建登录会话' });
    await setSessionCookie(ctx, { session, user }, !rememberMe);
    return ctx.json({ authenticated: true });
  }
  async function ticket(adapter: GenericEndpointContext['context']['internalAdapter']): Promise<ManagementTicket> {
    const value = generateRandomString(40);
    const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
    await adapter.createVerificationValue({ identifier: `musicfs-access:${value}`, value: ADMIN_ID, expiresAt });
    return { ticket: value, expiresAt: expiresAt.toISOString() };
  }
  const plugin = {
    id: 'musicfs-management',
    endpoints: {
      managementBootstrap: createAuthEndpoint('/bootstrap', {
        method: 'POST', body: z.object({ token: z.string() }),
      }, async ctx => {
        if (!constantTimeEqual(ctx.body.token, options.adminToken)) throw ctx.error('UNAUTHORIZED', { message: '管理凭据不正确' });
        return signIn(ctx);
      }),
      managementLogin: createAuthEndpoint('/login', {
        method: 'POST', body: z.object({ username, password: z.string().max(128), rememberMe: z.boolean().default(true) }),
      }, async ctx => {
        const record = await ctx.context.internalAdapter.findUserByEmail(ADMIN_EMAIL, { includeAccounts: true });
        const account = record?.accounts.find(value => value.providerId === 'credential');
        if (!record || record.user.name !== ctx.body.username || !account?.password
          || !await ctx.context.password.verify({ hash: account.password, password: ctx.body.password })) {
          throw ctx.error('UNAUTHORIZED', { message: '用户名或密码不正确' });
        }
        return signIn(ctx, ctx.body.rememberMe);
      }),
      managementAccount: createAuthEndpoint('/account', {
        method: 'PUT', body: z.object({ username, password }),
      }, async ctx => {
        await authorize(ctx);
        const user = await administrator(ctx);
        const account = (await ctx.context.internalAdapter.findAccounts(user.id)).find(value => value.providerId === 'credential');
        const hash = await ctx.context.password.hash(ctx.body.password);
        if (account) await ctx.context.internalAdapter.updateAccount(account.id, { password: hash });
        else await ctx.context.internalAdapter.linkAccount({ userId: user.id, accountId: user.id, providerId: 'credential', password: hash });
        await ctx.context.internalAdapter.updateUser(user.id, { name: ctx.body.username });
        if (account) {
          await ctx.context.internalAdapter.deleteUserSessions(user.id);
          await signIn(ctx);
        }
        return ctx.json({ authenticated: true, passwordConfigured: true, username: ctx.body.username } satisfies ManagementAccess);
      }),
      managementTicket: createAuthEndpoint('/ticket', { method: 'POST' }, async ctx => {
        await authorize(ctx);
        return ctx.json(await ticket(ctx.context.internalAdapter));
      }),
      managementExchange: createAuthEndpoint('/exchange', {
        method: 'POST', body: z.object({ ticket: z.string().min(1).max(256) }),
      }, async ctx => {
        const value = await ctx.context.internalAdapter.consumeVerificationValue(`musicfs-access:${ctx.body.ticket}`);
        if (!value || value.value !== ADMIN_ID) throw ctx.error('UNAUTHORIZED', { message: '访问链接已使用或过期，请重新获取' });
        // Each device receives a new session. Signing out on the phone does not sign out the desktop.
        return signIn(ctx);
      }),
      managementLogout: createAuthEndpoint('/logout', { method: 'POST' }, async ctx => {
        const session = await getSessionFromCtx(ctx);
        if (session) await ctx.context.internalAdapter.deleteSession(session.session.token);
        deleteSessionCookie(ctx);
        return ctx.json({ authenticated: false });
      }),
    },
  };
  const instances = new Map<string, ReturnType<typeof makeAuth>>();
  function makeAuth(protocol: 'http' | 'https') {
    return betterAuth({
      appName: 'MusicFS', database: options.database, secret: sessionSecret,
      basePath: '/api/access',
      // The listener can expose loopback, LAN IPs and HTTPS. The outer boundary checks exact same-origin.
      baseURL: { allowedHosts: ['*'], protocol },
      user: { modelName: 'management_user' },
      account: { modelName: 'management_account' },
      verification: { modelName: 'management_verification' },
      session: { modelName: 'management_session', expiresIn: 30 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
      emailAndPassword: { enabled: true, disableSignUp: true },
      advanced: { cookiePrefix: `musicfs-${(options.instanceId ?? 'admin').replace(/[^a-zA-Z0-9_-]/g, '')}`,
        useSecureCookies: protocol === 'https', database: { validateSchema: false } },
      telemetry: { enabled: false },
      logger: { level: 'error', log: (_level, _message, ...args: unknown[]) => {
        getLogger(['musicfs', 'auth']).error('Management authentication handler failed', errorFields(args.find(value => value instanceof Error)));
      } },
      plugins: [plugin],
    });
  }
  function authForProtocol(protocol: 'http' | 'https') {
    let auth = instances.get(protocol);
    if (!auth) { auth = makeAuth(protocol); instances.set(protocol, auth); }
    return auth;
  }
  function authFor(request: Request) {
    return authForProtocol(new URL(request.url).protocol === 'https:' ? 'https' : 'http');
  }
  function requestHeaders(request: Request) {
    const headers = new Headers(request.headers);
    if (!headers.has('host')) headers.set('host', new URL(request.url).host);
    return headers;
  }
  async function sessionFor(request: Request) {
    return authFor(request).api.getSession({ headers: requestHeaders(request), returnHeaders: true });
  }
  const sameOrigin: MiddlewareHandler = async (ctx, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(ctx.req.method)) {
      const origin = ctx.req.header('origin');
      if (origin && origin !== new URL(ctx.req.url).origin) return ctx.json({ error: 'invalid_origin', message: '请从当前管理页面操作' }, 403);
      if (!origin && ctx.req.header('sec-fetch-site') === 'cross-site') return ctx.json({ error: 'invalid_origin', message: '请从当前管理页面操作' }, 403);
    }
    await next();
  };
  const middleware: MiddlewareHandler = async (ctx, next) => {
    return sameOrigin(ctx, async () => {
      if (!hasBearer(ctx.req.raw.headers)) {
        const result = await sessionFor(ctx.req.raw);
        for (const cookie of result.headers.getSetCookie()) ctx.header('Set-Cookie', cookie, { append: true });
        if (!result.response || result.response.user.id !== ADMIN_ID) {
          ctx.res = ctx.json({ error: 'unauthorized', message: '请先登录' }, 401);
          return;
        }
      }
      await next();
    });
  };
  const app = new Hono();
  app.use('/api/access', async (ctx, next) => { ctx.header('Cache-Control', 'no-store'); await next(); });
  app.use('/api/access/*', async (ctx, next) => { ctx.header('Cache-Control', 'no-store'); await next(); });
  app.use('/api/access/*', sameOrigin);
  app.get('/api/access', async ctx => {
    const auth = authFor(ctx.req.raw);
    const result = await sessionFor(ctx.req.raw);
    for (const cookie of result.headers.getSetCookie()) ctx.header('Set-Cookie', cookie, { append: true });
    const authenticated = hasBearer(ctx.req.raw.headers) || result.response?.user.id === ADMIN_ID;
    const internal = await auth.$context;
    const record = await internal.internalAdapter.findUserByEmail(ADMIN_EMAIL, { includeAccounts: true });
    const passwordConfigured = Boolean(record?.accounts.some(value => value.providerId === 'credential' && value.password));
    return ctx.json({ authenticated, passwordConfigured, ...(options.host ? { host: options.host } : {}), ...(authenticated && record ? { username: record.user.name } : {}) } satisfies ManagementAccess);
  });
  // Only these product endpoints are exposed. Better Auth registration/social/email endpoints stay internal.
  for (const [path, method] of [['login', 'POST'], ['bootstrap', 'POST'], ['logout', 'POST'], ['account', 'PUT'], ['ticket', 'POST'], ['exchange', 'POST']] as const) {
    app.on(method, `/api/access/${path}`, ctx => {
      const headers = requestHeaders(ctx.req.raw);
      // Native callers authenticate explicitly and do not send browser Origin headers.
      if (!headers.has('origin')) headers.set('origin', new URL(ctx.req.url).origin);
      if (path === 'ticket' || path === 'logout') {
        // These commands have no product input. Give the auth router a consistent empty JSON object.
        headers.set('Content-Type', 'application/json'); headers.delete('Content-Length');
        return authFor(ctx.req.raw).handler(new Request(ctx.req.raw, { headers, body: '{}' }));
      }
      return authFor(ctx.req.raw).handler(new Request(ctx.req.raw, { headers }));
    });
  }
  return {
    app, middleware,
    /** Native launcher/tray use this narrow interface; browser clients use the authenticated HTTP endpoint. */
    async issueTicket(): Promise<ManagementTicket> {
      const auth = authForProtocol('http');
      const context = await auth.$context;
      return ticket(context.internalAdapter);
    },
  };
}
