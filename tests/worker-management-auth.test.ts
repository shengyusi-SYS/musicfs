import { expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { buildWorker } from '../scripts/build-worker';
import { MANAGEMENT_AUTH_SCHEMA_SQL } from '../src/infrastructure/management-auth/schema';

test('the packaged Worker creates a management session and protects the shared API after logout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-worker-management-'));
  let runtime: Miniflare | undefined;
  try {
    const migration = await Bun.file('src/infrastructure/persistence/migrations/0011.sql').text();
    const sql = (value: string) => value.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim();
    expect(sql(migration)).toBe(sql(MANAGEMENT_AUTH_SCHEMA_SQL));
    const bundle = await buildWorker({ directory });
    const nativeCrypto = await Bun.file(join(directory, 'core.mjs')).text();
    expect(nativeCrypto).toContain('password.node.mjs');
    const token = 'worker-management-fixture-token-with-enough-entropy';
    runtime = new Miniflare({ modulesRoot: directory,
      modules: bundle.modules.map(module => ({ type: module.type === 'esm' ? 'ESModule' as const : module.type === 'text' ? 'Text' as const : 'Data' as const,
        path: join(directory, module.file) })),
      compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'worker-management-tests' },
      bindings: { ADMIN_TOKEN: token, DAV_USERNAME: 'reader', DAV_PASSWORD: 'reader-fixture', CF_ACCOUNT_ID: '', CF_WORKER_NAME: '', CF_API_TOKEN: '' },
      log: new Log(LogLevel.ERROR) });
    const database = await runtime.getD1Database('DB');
    for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
      await database.exec(sql(await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()));
    }
    const origin = (await runtime.ready).origin;
    const request = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => runtime!.dispatchFetch(origin + path, init);
    const denied = await request('/api/status');
    expect(denied.status).toBe(401); await denied.body?.cancel();
    const bootstrap = await request('/api/access/bootstrap', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
    expect(bootstrap.status).toBe(200); await bootstrap.body?.cancel();
    const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    expect(cookie.length).toBeGreaterThan(0);
    const signedIn = await request('/api/status', { headers: { Cookie: cookie } });
    expect(signedIn.status).toBe(200); expect((await signedIn.json() as { host: string }).host).toBe('worker');
    const credentials = { username: 'player', password: 'worker-player:@/#?' };
    const saved = await request('/api/connection', { method: 'PUT', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
    expect(saved.status).toBe(200); expect(await saved.json()).toEqual({ davPath: '/dav', ...credentials });
    const connection = await request('/api/connection', { headers: { Cookie: cookie } });
    expect(await connection.json()).toEqual({ davPath: '/dav', ...credentials });
    const oldPlayer = await request('/dav/', { method: 'OPTIONS', headers: { Authorization: 'Basic ' + btoa('reader:reader-fixture') } });
    expect(oldPlayer.status).toBe(401); await oldPlayer.body?.cancel();
    const player = await request('/dav/', { method: 'OPTIONS', headers: { Authorization: 'Basic ' + btoa(`${credentials.username}:${credentials.password}`) } });
    expect(player.status).toBe(200); await player.body?.cancel();
    const logout = await request('/api/access/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
    expect(logout.status).toBe(200); await logout.body?.cancel();
    // Reusing the old cookie must fail even when a client has not applied its deletion header.
    const expired = await request('/api/status', { headers: { Cookie: cookie } });
    expect(expired.status).toBe(401); await expired.body?.cancel();
    const automation = await request('/api/status', { headers: { Authorization: `Bearer ${token}` } });
    expect(automation.status).toBe(200); await automation.body?.cancel();
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 20_000);
