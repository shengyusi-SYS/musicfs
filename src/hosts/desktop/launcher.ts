import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import envPaths from 'env-paths';
import open from 'open';
import { lock } from 'proper-lockfile';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { z } from 'zod';
import { createDesktopService } from './service';
import { createMountManager } from './mounts';
import { writePrivateJson } from './rclone-control';
import { readDesktopNetworkSettings } from './network';
import { createMountPrerequisites } from './mount-prerequisites';
import { createDesktopHttps } from './https';
import { createDesktopHttp } from './http';

const credentialsSchema = z.object({ instanceId: z.uuid(), adminToken: z.string().min(32), username: z.literal('musicfs'), password: z.string().min(32) }).strict();
const runtimeSchema = z.object({ pid: z.number().int().positive(), origin: z.string(), instanceId: z.uuid() }).strict();
type Credentials = z.infer<typeof credentialsSchema>;
type Runtime = z.infer<typeof runtimeSchema>;
const lockStaleMs = 30_000;
const lockRecoveryMs = lockStaleMs + 2_000;
const startupTimeoutMs = lockRecoveryMs + 15_000;

export const defaultDesktopDirectory = () => envPaths('MusicFS', { suffix: '' }).data;

async function readExisting(directory: string): Promise<{ runtime: Runtime; credentials: Credentials } | undefined> {
  try {
    const runtime = runtimeSchema.parse(JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')));
    const credentials = credentialsSchema.parse(JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8')));
    const location = new URL(runtime.origin);
    if (location.protocol !== 'http:' || location.hostname !== '127.0.0.1' || location.pathname !== '/' || location.search || location.hash
      || location.username || location.password || credentials.instanceId !== runtime.instanceId) return;
    const response = await fetch(new URL('/__musicfs/identity', location), {
      headers: { Authorization: `Bearer ${credentials.adminToken}` }, signal: AbortSignal.timeout(800), redirect: 'error'
    });
    if (!response.ok) { await response.body?.cancel(); return; }
    const identity = runtimeSchema.parse(await response.json());
    if (identity.instanceId !== runtime.instanceId || identity.pid !== runtime.pid || identity.origin !== runtime.origin) return;
    return { runtime, credentials };
  } catch { return; }
}

async function acquireBackgroundLock(directory: string): Promise<(() => Promise<void>) | undefined> {
  const deadline = Date.now() + lockRecoveryMs;
  for (;;) {
    // A competing starter leaves as soon as the winner is healthy. An opaque
    // long lock retry would keep this otherwise unused process alive.
    if (await readExisting(directory)) return;
    try { return await lock(directory, { realpath: false, stale: lockStaleMs, update: 10_000, retries: 0 }); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ELOCKED')) throw error;
      if (Date.now() >= deadline) throw new Error('MusicFS 后台锁暂不可用，请稍后重试并查看 launcher.log。');
    }
    // proper-lockfile alone owns the lock and its stale decision; the host only
    // coordinates bounded retries with the authenticated readiness handshake.
    await Bun.sleep(200);
  }
}

/** A click starts the detached backend or opens the verified existing one. */
export async function launchDesktop(input: {
  command: string[]; directory?: string; resourcesDirectory: string;
  openBrowser?: boolean; browser?: (url: string) => Promise<unknown>; startupTimeoutMs?: number;
}): Promise<{ origin: string; reused: boolean }> {
  const directory = resolve(input.directory ?? defaultDesktopDirectory());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let existing = await readExisting(directory);
  const reused = !!existing;
  if (!existing) {
    const log = openSync(join(directory, 'launcher.log'), 'a', 0o600);
    try {
      const [executable, ...args] = input.command;
      if (!executable) throw new Error('Desktop executable is required');
      const child = spawn(executable, [...args, '--background', '--data', directory, '--resources', resolve(input.resourcesDirectory)], {
        detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env
      });
      await new Promise<void>((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
      child.unref();
    } finally { closeSync(log); }
    const deadline = Date.now() + (input.startupTimeoutMs ?? startupTimeoutMs);
    while (Date.now() < deadline) {
      existing = await readExisting(directory);
      if (existing) break;
      await Bun.sleep(75);
    }
    if (!existing) throw new Error(`MusicFS 后台未能启动，请查看 ${join(directory, 'launcher.log')}。`);
  }
  if (input.openBrowser !== false) {
    const url = new URL(existing.runtime.origin);
    url.hash = new URLSearchParams({ token: existing.credentials.adminToken }).toString();
    try { await (input.browser ?? open)(url.href); }
    catch { throw new Error(`后台已运行，系统浏览器未能打开。可重新点击启动器；诊断目录：${directory}。`); }
  }
  return { origin: existing.runtime.origin, reused };
}

/** Holds the cross-process lock for the entire backend lifetime. */
export async function startDesktopBackground(input: { directory?: string; resourcesDirectory: string }): Promise<{ origin: string; close(): Promise<void> } | undefined> {
  const directory = resolve(input.directory ?? defaultDesktopDirectory());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const acquired = await acquireBackgroundLock(directory);
  if (!acquired) return;
  const release: () => Promise<void> = acquired;
  let service: Awaited<ReturnType<typeof createDesktopService>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let https: Awaited<ReturnType<typeof createDesktopHttps>> | undefined;
  let closing: Promise<void> | undefined;
  const runtimePath = join(directory, 'runtime.json');
  try {
    const credentialsPath = join(directory, 'credentials.json');
    let credentials: Credentials;
    try { credentials = credentialsSchema.parse(JSON.parse(await readFile(credentialsPath, 'utf8'))); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('本机凭据无法读取，请保留数据并检查 credentials.json。');
      credentials = { instanceId: crypto.randomUUID(), adminToken: crypto.randomUUID() + crypto.randomUUID(), username: 'musicfs', password: crypto.randomUUID() + crypto.randomUUID() };
      await writePrivateJson(credentialsPath, credentials);
    }
    const resources = resolve(input.resourcesDirectory);
    if (!await Bun.file(join(resources, 'web', 'index.html')).exists()) throw new Error('发行包缺少共用管理页面，请重新解压完整发行包。');
    const network = await readDesktopNetworkSettings(directory);
    let preferredPort = network.port;
    try {
      const previous = runtimeSchema.parse(JSON.parse(await readFile(runtimePath, 'utf8')));
      const address = new URL(previous.origin);
      if (previous.instanceId === credentials.instanceId && address.protocol === 'http:' && address.hostname === '127.0.0.1'
        && address.pathname === '/' && !address.search && !address.hash && !address.username && !address.password) {
        const port = Number(address.port || 80);
        if (!preferredPort && Number.isInteger(port) && port > 0 && port <= 65535) preferredPort = port;
      }
    } catch { /* Missing or invalid crash metadata cannot choose a listening endpoint. */ }
    let origin = '';
    const prerequisites = createMountPrerequisites({ resourcesDirectory: resources });
    const mounts = await createMountManager({ directory: join(directory, 'mounts'), binary: join(resources, process.platform === 'win32' ? 'rclone.exe' : 'rclone'),
      localConnection: () => ({ url: `${origin}/dav/`, username: credentials.username, password: credentials.password }),
      ...(process.platform === 'win32' ? { checkDependencies: () => prerequisites.check() } : {}) });
    service = await createDesktopService({ directory, adminToken: credentials.adminToken,
      dav: { username: credentials.username, password: credentials.password }, webRoot: join(resources, 'web'), mounts });
    https = await createDesktopHttps({ directory: join(directory, 'https'), fetch: service.app.fetch });
    const app = new Hono();
    app.use('/__musicfs/*', bearerAuth({ token: credentials.adminToken }));
    app.get('/__musicfs/identity', c => c.json({ pid: process.pid, origin, instanceId: credentials.instanceId }));
    app.route('/', createDesktopHttp({ directory, adminToken: credentials.adminToken, network, port: () => server!.port!, mounts, prerequisites, https, close }));
    app.route('/', service.app);
    const hostname = network.access === 'lan' ? '0.0.0.0' : '127.0.0.1';
    try { server = Bun.serve({ hostname, port: preferredPort, fetch: app.fetch, idleTimeout: 0 }); }
    catch (error) {
      if (!preferredPort || !(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')) throw error;
      server = Bun.serve({ hostname, port: 0, fetch: app.fetch, idleTimeout: 0 });
    }
    // Launcher identity and local mounts always use a concrete loopback address,
    // including when the same listener also accepts LAN clients.
    origin = `http://127.0.0.1:${server.port}`;
    await writePrivateJson(runtimePath, { pid: process.pid, origin, instanceId: credentials.instanceId });
    async function close() {
      if (closing) return closing;
      closing = (async () => {
        await service!.close();
        await https!.close();
        await server!.stop(false);
        await rm(runtimePath, { force: true });
        await release();
      })();
      try { await closing; } catch (error) { closing = undefined; throw error; }
    }
    return { origin, close };
  } catch (error) {
    await https?.close();
    await server?.stop(true);
    await service?.close();
    await rm(runtimePath, { force: true });
    await release();
    throw error;
  }
}
