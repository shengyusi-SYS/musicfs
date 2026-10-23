import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import envPaths from 'env-paths';
import open from 'open';
import { lock } from 'proper-lockfile';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { createDesktopService } from './service';
import { createMountManager } from './mounts';
import { createRcloneControl, writePrivateJson } from './rclone-control';
import { desktopNetworkSchema, readDesktopNetworkState, saveDesktopNetworkSettings } from './network';
import { createMountPrerequisites } from './mount-prerequisites';
import { createDesktopHttps } from './https';
import { createDesktopHttp } from './http';
import { createMountRestore, type MountRestore } from './mount-restore';
import { readDesktopPreferences, saveDesktopPreferences } from './preferences';
import { openDesktopBrowser, setDesktopAutostart, startDesktopIntegration } from './integration';
import type { DesktopNetworkSettings, DesktopPreferencesView } from '../../contracts/desktop';
import { createDesktopListener } from './listener';
import { configureDesktopEntry, credentialsSchema, desktopLogin, readDesktopRuntime as readExisting, runtimeSchema, type DesktopCredentials } from './entry';

const lockStaleMs = 30_000;
const lockRecoveryMs = lockStaleMs + 2_000;
const startupTimeoutMs = lockRecoveryMs + 15_000;

function localPort(value: string | undefined): number {
  if (!value) return 0;
  try {
    const address = new URL(value);
    return address.protocol === 'http:' && address.hostname === '127.0.0.1' && address.pathname === '/' && !address.search
      && !address.hash && !address.username && !address.password ? Number(address.port || 80) : 0;
  } catch { return 0; }
}

async function openDesktopPage(url: string, resourcesDirectory: string): Promise<unknown> {
  return process.platform === 'win32' ? openDesktopBrowser({ resourcesDirectory, url }) : open(url);
}

export const defaultDesktopDirectory = () => envPaths('MusicFS', { suffix: '' }).data;

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
  loginStartup?: boolean; systemIntegration?: boolean;
  network?: Partial<DesktopNetworkSettings>;
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
      const child = spawn(executable, [...args, '--background', '--data', directory, '--resources', resolve(input.resourcesDirectory),
        ...(input.systemIntegration === false ? ['--no-integration'] : [])], {
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
  if (input.network) existing = await configureDesktopEntry(directory, input.network);
  const preferences = await readDesktopPreferences(directory);
  if (input.systemIntegration) {
    await writePrivateJson(join(directory, 'startup.json'), { command: input.command, resourcesDirectory: resolve(input.resourcesDirectory) });
    try { await setDesktopAutostart({ resourcesDirectory: resolve(input.resourcesDirectory), enabled: preferences.launchAtLogin,
      command: [...input.command, '--autostart', '--data', directory, '--resources', resolve(input.resourcesDirectory)] }); }
    catch { console.error('MusicFS: login startup registration failed. Open Settings to retry.'); }
  }
  const openBrowser = input.openBrowser ?? (input.loginStartup ? preferences.openOnLogin : preferences.openOnLaunch);
  if (openBrowser) {
    const { url } = await desktopLogin(existing);
    try { await (input.browser ?? (url => openDesktopPage(url, input.resourcesDirectory)))(url); }
    catch { throw new Error(`后台已运行，系统浏览器未能打开。可重新点击启动器；诊断目录：${directory}。`); }
  }
  return { origin: existing.runtime.origin, reused };
}

/** Holds the cross-process lock for the entire backend lifetime. */
export async function startDesktopBackground(input: { directory?: string; resourcesDirectory: string; command?: string[]; systemIntegration?: boolean; network?: Partial<DesktopNetworkSettings> }): Promise<{ readonly origin: string; readonly davOrigin: string; close(): Promise<void> } | undefined> {
  const directory = resolve(input.directory ?? defaultDesktopDirectory());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const acquired = await acquireBackgroundLock(directory);
  if (!acquired) return;
  const release: () => Promise<void> = acquired;
  let service: Awaited<ReturnType<typeof createDesktopService>> | undefined;
  let listener: ReturnType<typeof createDesktopListener> | undefined;
  let https: Awaited<ReturnType<typeof createDesktopHttps>> | undefined;
  let closing: Promise<void> | undefined;
  let restore: MountRestore | undefined;
  let integration: Awaited<ReturnType<typeof startDesktopIntegration>> | undefined;
  let integrationReady: Promise<void> | undefined;
  const runtimePath = join(directory, 'runtime.json');
  try {
    const credentialsPath = join(directory, 'credentials.json');
    let credentials: DesktopCredentials;
    try { credentials = credentialsSchema.parse(JSON.parse(await readFile(credentialsPath, 'utf8'))); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('本机凭据无法读取，请保留数据并检查 credentials.json。');
      credentials = { instanceId: crypto.randomUUID(), adminToken: crypto.randomUUID() + crypto.randomUUID(), username: 'musicfs', password: crypto.randomUUID() + crypto.randomUUID() };
      await writePrivateJson(credentialsPath, credentials);
    }
    const resources = resolve(input.resourcesDirectory);
    if (!await Bun.file(join(resources, 'web', 'index.html')).exists()) throw new Error('发行包缺少共用管理页面，请重新解压完整发行包。');
    const storedNetwork = await readDesktopNetworkState(directory);
    const network = input.network ? desktopNetworkSchema.parse({ ...storedNetwork.settings, ...input.network }) : storedNetwork.settings;
    let preferences = await readDesktopPreferences(directory);
    const integrationState: DesktopPreferencesView['integration'] = { available: false, enabled: !!input.systemIntegration };
    const preferred = { managementPort: storedNetwork.assignedPorts?.managementPort ?? 0, davPort: storedNetwork.assignedPorts?.davPort ?? 0 };
    try {
      const previous = runtimeSchema.parse(JSON.parse(await readFile(runtimePath, 'utf8')));
      if (previous.instanceId === credentials.instanceId) {
        if (previous.davOrigin) {
          preferred.managementPort ||= localPort(previous.origin);
          preferred.davPort ||= localPort(previous.davOrigin);
        } else preferred.davPort ||= localPort(previous.origin);
      }
    } catch { /* Missing or invalid crash metadata cannot choose a listening endpoint. */ }
    let origin = ''; let davOrigin = '';
    const prerequisites = createMountPrerequisites({ resourcesDirectory: resources });
    const controlDirectory = join(directory, 'mounts');
    const binary = join(resources, process.platform === 'win32' ? 'rclone.exe' : 'rclone');
    const control = createRcloneControl({ directory: controlDirectory, binary });
    const mounts = await createMountManager({ control, manageControl: false, directory: controlDirectory, binary,
      localConnection: () => service?.readCache?.mountConnection ?? ({ url: `${davOrigin}/dav/`, ...(service?.davAccess.get() ?? { username: credentials.username, password: credentials.password }) }),
      ...(process.platform === 'win32' ? { checkDependencies: () => prerequisites.check() } : {}) });
    restore = createMountRestore({ mounts, settings: { enabled: preferences.autoMount, retry: preferences.retryAutoMount },
      onError: () => console.error('MusicFS: a saved mount could not be restored. See Connections for details.') });
    service = await createDesktopService({ directory, adminToken: credentials.adminToken, instanceId: credentials.instanceId,
      mountAction: id => restore!.cancel(id),
      dav: { username: credentials.username, password: credentials.password }, webRoot: join(resources, 'web'), mounts, readCache: { control, controlDirectory } });
    const app = new Hono();
    https = await createDesktopHttps({ directory: join(directory, 'https'), fetch: service.davApp.fetch });
    app.use('/__musicfs/*', bearerAuth({ token: credentials.adminToken }));
    app.get('/__musicfs/identity', c => c.json({ pid: process.pid, origin, davOrigin, instanceId: credentials.instanceId }));
    const inspectPreferences = (): DesktopPreferencesView => ({ settings: { ...preferences }, integration: { ...integrationState } });
    app.route('/', createDesktopHttp({ directory, adminToken: credentials.adminToken, managementAuth: service.access.middleware,
      preferences: { inspect: inspectPreferences, async configure(next) {
        if (input.systemIntegration && (next.launchAtLogin !== preferences.launchAtLogin || integrationState.error)) {
          const target = await readFile(join(directory, 'startup.json'), 'utf8').then(value => JSON.parse(value) as { command: string[]; resourcesDirectory: string },
            () => ({ command: input.command!, resourcesDirectory: resources }));
          if (target.command?.length) {
            await setDesktopAutostart({ resourcesDirectory: target.resourcesDirectory, enabled: next.launchAtLogin,
              command: [...target.command, '--autostart', '--data', directory, '--resources', target.resourcesDirectory] });
            delete integrationState.error;
          }
        }
        await saveDesktopPreferences(directory, next); preferences = next;
        restore!.configure({ enabled: next.autoMount, retry: next.retryAutoMount });
        return inspectPreferences();
      } },
      network: () => listener!.current()!, mounts, prerequisites, https,
      async configureNetwork(next) {
        const previous = listener!.current()!;
        listener!.reconfigure(next);
        try { await saveDesktopNetworkSettings(directory, next, listener!.current()!); }
        catch (error) { listener!.reconfigure(previous); throw error; }
        origin = listener!.current()!.origin; davOrigin = listener!.current()!.davOrigin;
        await writePrivateJson(runtimePath, { pid: process.pid, origin, davOrigin, instanceId: credentials.instanceId });
      },
      prepareShutdown: () => restore!.pause(),
      ...(service.readCache ? { readCache: service.readCache, prepareQuit: async () => service!.readCache!.prepareQuit() } : {}), close }));
    app.route('/', service.app);
    listener = createDesktopListener({ fetch: app.fetch });
    listener.listen({ ...network, managementPort: network.managementPort || preferred.managementPort, davPort: network.davPort || preferred.davPort }, { fallback: true });
    // Launcher identity and local mounts always use a concrete loopback address,
    // independent of either endpoint's LAN access setting.
    origin = listener.current()!.origin; davOrigin = listener.current()!.davOrigin;
    await saveDesktopNetworkSettings(directory, network, listener.current()!);
    await writePrivateJson(runtimePath, { pid: process.pid, origin, davOrigin, instanceId: credentials.instanceId });
    restore.start();
    if (input.systemIntegration) {
      integrationReady = (async () => {
        async function openManagement(phone = false, quitFailed = false) {
          const url = new URL(origin);
          if (phone) url.searchParams.set('phone', '1');
          if (quitFailed) { url.searchParams.set('page', 'connection'); url.searchParams.set('quitFailed', '1'); }
          url.hash = new URLSearchParams({ ticket: (await service!.access.issueTicket()).ticket }).toString();
          await openDesktopPage(url.href, resources);
        }
        integration = await startDesktopIntegration({ resourcesDirectory: resources,
          onError: error => { integrationState.error = error.message; },
          onAction: action => {
            if (closing) return;
            void (async () => {
              if (action === 'open' || action === 'phone') return openManagement(action === 'phone');
              const response = await fetch(new URL('/api/desktop/quit', origin), { method: 'POST', headers: { Authorization: `Bearer ${credentials.adminToken}` } });
              await response.body?.cancel();
              if (!response.ok) await openManagement(false, true);
            })().catch(() => { integrationState.error = '桌面操作未完成，请重新打开管理页面。'; });
          }
        });
        integrationState.available = !integrationState.error;
      })().catch(() => { integrationState.error = '托盘未能启动，可再次运行 MusicFS 打开管理页面。'; });
    }
    async function close() {
      if (closing) return closing;
      closing = (async () => {
        const resumeRestore = await restore!.pause();
        try { await service!.close(); }
        catch (error) { resumeRestore(); throw error; }
        await restore!.close();
        await integrationReady; await integration?.close();
        await https!.close();
        await listener!.close();
        await rm(runtimePath, { force: true });
        await release();
      })();
      try { await closing; } catch (error) { closing = undefined; throw error; }
    }
    return { get origin() { return origin; }, get davOrigin() { return davOrigin; }, close };
  } catch (error) {
    await restore?.close();
    await integrationReady; await integration?.close();
    await https?.close();
    await listener?.close();
    await service?.close();
    await rm(runtimePath, { force: true });
    await release();
    throw error;
  }
}
