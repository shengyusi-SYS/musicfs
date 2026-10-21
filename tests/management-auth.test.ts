import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { createManagementAuth, MANAGEMENT_AUTH_SCHEMA_SQL } from '../src/infrastructure/management-auth';
import { workerCrypto } from '../scripts/helpers/worker-crypto';

const origin = 'http://musicfs';
const token = 'fixture-admin-01234567890123456789';
type Fetcher = (request: Request) => Promise<Response> | Response;
function cookie(response: Response) {
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}
async function journey(fetcher: Fetcher, base = origin) {
  const request = (path: string, method = 'GET', body?: unknown, session = '') => fetcher(new Request(base + path, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Origin: base, ...(session ? { Cookie: session } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  expect((await request('/api/private')).status).toBe(401);
  expect(await (await request('/api/access')).json()).toEqual({ authenticated: false, passwordConfigured: false });
  const bootstrap = await request('/api/access/bootstrap', 'POST', { token });
  expect(bootstrap.status, await bootstrap.clone().text()).toBe(200);
  const desktop = cookie(bootstrap);
  expect(desktop).toContain('musicfs-fixture.session_token=');
  expect(bootstrap.headers.get('Set-Cookie')).toContain('HttpOnly');
  expect(bootstrap.headers.get('Set-Cookie')).not.toContain('Secure');
  expect((await request('/api/private', 'GET', undefined, desktop)).status).toBe(200);

  const setup = await request('/api/access/account', 'PUT', { username: '音乐管理员', password: 'first-password' }, desktop);
  expect(setup.status).toBe(200);
  expect(await setup.json()).toEqual({ authenticated: true, passwordConfigured: true, username: '音乐管理员' });
  const generated = await request('/api/access/ticket', 'POST', undefined, desktop);
  expect(generated.status).toBe(200);
  const ticket = await generated.json() as { ticket: string; expiresAt: string };
  expect(Date.parse(ticket.expiresAt)).toBeGreaterThan(Date.now());
  const exchange = await request('/api/access/exchange', 'POST', { ticket: ticket.ticket });
  expect(exchange.status).toBe(200);
  const phone = cookie(exchange);
  expect(phone).not.toBe(desktop);
  expect((await request('/api/access/exchange', 'POST', { ticket: ticket.ticket })).status).toBe(401);
  expect((await request('/api/access/logout', 'POST', undefined, phone)).status).toBe(200);
  expect((await request('/api/private', 'GET', undefined, phone)).status).toBe(401);
  expect((await request('/api/private', 'GET', undefined, desktop)).status).toBe(200);

  const login = await request('/api/access/login', 'POST', { username: '音乐管理员', password: 'first-password', rememberMe: false });
  expect(login.status).toBe(200);
  const browser = cookie(login);
  expect(login.headers.get('Set-Cookie')).not.toContain('Max-Age=');
  expect((await request('/api/access/login', 'POST', { username: '音乐管理员', password: 'incorrect', rememberMe: true })).status).toBe(401);
  const changed = await request('/api/access/account', 'PUT', { username: 'owner', password: 'second-password' }, browser);
  expect(changed.status).toBe(200);
  const updated = cookie(changed);
  expect(updated).toBeTruthy();
  expect((await request('/api/private', 'GET', undefined, updated)).status).toBe(200);
  expect((await request('/api/private', 'GET', undefined, desktop)).status).toBe(401);
  expect((await request('/api/access/login', 'POST', { username: 'owner', password: 'second-password', rememberMe: true })).status).toBe(200);
  expect((await request('/api/access/sign-up/email', 'POST', {})).status).toBe(404);
  const foreign = await fetcher(new Request(base + '/api/access/ticket', {
    method: 'POST', headers: { Origin: 'http://another-site', Cookie: updated },
  }));
  expect(foreign.status).toBe(403);
}

test('desktop management: bootstrap, independent phone session, password login and logout', async () => {
  const db = new Database(':memory:');
  db.exec(MANAGEMENT_AUTH_SCHEMA_SQL);
  const access = createManagementAuth({ database: db, adminToken: token, instanceId: 'fixture' });
  const app = new Hono();
  app.route('/', access.app);
  app.use('/api/private', access.middleware);
  app.get('/api/private', ctx => ctx.json({ ok: true }));
  try {
    await journey(request => app.fetch(request));
    const native = await access.issueTicket();
    const https = await app.request('https://musicfs/api/access/exchange', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: native.ticket }) });
    expect(https.status).toBe(200);
    expect(https.headers.get('Set-Cookie')).toContain('__Secure-musicfs-fixture.session_token=');
    expect(https.headers.get('Set-Cookie')).toContain('Secure');
    expect(db.query('SELECT COUNT(*) AS count FROM management_user').get()).toEqual({ count: 1 });
  } finally { db.close(); }
});

test('local workerd runs the same management journey with D1 and native scrypt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-management-auth-'));
  const build = await Bun.build({ entrypoints: ['tests/probes/worker-management-auth.ts'], target: 'browser', format: 'esm',
    conditions: ['workerd'], outdir: directory, naming: 'worker.mjs', plugins: [workerCrypto] });
  if (!build.success) throw new AggregateError(build.logs, 'Management auth fixture build failed');
  const source = await build.outputs[0]!.text();
  expect(source).toContain('password.node');
  const mf = new Miniflare({ modulesRoot: directory, modules: [{ type: 'ESModule', path: join(directory, 'worker.mjs') }],
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'management-auth' },
    log: new Log(LogLevel.ERROR) });
  try {
    const db = await mf.getD1Database('DB');
    await db.exec(MANAGEMENT_AUTH_SCHEMA_SQL.replaceAll('\n', ' '));
    await journey(async request => {
      const response = await mf.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
        ...(request.body ? { body: await request.text() } : {}) });
      // Miniflare uses Undici's Response type; this boundary does not use Bun's extra textStream method.
      return response as unknown as Response;
    }, (await mf.ready).origin);
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 25_000);
