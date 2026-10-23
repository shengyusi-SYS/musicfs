import { join } from 'node:path';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { DesktopNetworkSettings, DesktopPreferences, DesktopPreferencesView } from '../../contracts/desktop';
import type { MountManager } from '../../contracts/mounts';
import type { MountPrerequisites } from '../../contracts/mount-prerequisites';
import type { ReadCacheManager } from '../../contracts/read-cache';
import { desktopNetworkSchema, desktopNetworkView, readDesktopNetworkSettings } from './network';
import { MountError, writePrivateJson } from './rclone-control';
import { DesktopHttpsError, type createDesktopHttps } from './https';
import { desktopPreferencesSchema } from './preferences';

const readCacheSettingsSchema = z.object({
  maxMiB: z.number().int().min(0).max(1_048_576),
  maxAgeHours: z.number().int().min(0).max(2_147_483)
}).strict();
const networkUpdateSchema = desktopNetworkSchema.partial().refine(value => Object.keys(value).length > 0);

/** Desktop capabilities never enter the shared music domains or Worker host. */
export function createDesktopHttp(input: {
  directory: string; adminToken: string; network: DesktopNetworkSettings | (() => DesktopNetworkSettings); port: () => number;
  configureNetwork?: (settings: DesktopNetworkSettings) => Promise<void>;
  managementAuth?: import('hono').MiddlewareHandler;
  preferences?: { inspect(): DesktopPreferencesView; configure(settings: DesktopPreferences): Promise<DesktopPreferencesView> };
  mounts: MountManager; prerequisites: MountPrerequisites;
  readCache?: ReadCacheManager;
  https: Awaited<ReturnType<typeof createDesktopHttps>>;
  prepareQuit?: () => Promise<void | (() => void)>;
  close: () => Promise<void>;
  prepareShutdown?: () => Promise<void | (() => void)>;
}) {
  const app = new Hono();
  app.use('/api/desktop/*', input.managementAuth ?? bearerAuth({ token: input.adminToken }), async (c, next) => {
    c.header('Cache-Control', 'no-store'); await next();
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof MountError || error instanceof DesktopHttpsError) return c.json({ error: error.code, message: error.message }, 422);
    return c.json({ error: 'desktop_failed', message: '本机操作未完成，请检查后台日志后重试。' }, 500);
  });
  const networkView = async () => desktopNetworkView(await readDesktopNetworkSettings(input.directory), typeof input.network === 'function' ? input.network() : input.network, input.port());
  app.get('/api/desktop/network', async c => c.json(await networkView()));
  app.get('/api/desktop/preferences', c => input.preferences ? c.json(input.preferences.inspect()) : c.notFound());
  app.put('/api/desktop/preferences', async c => {
    if (!input.preferences) return c.notFound();
    const parsed = desktopPreferencesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_preferences', message: '请选择有效的启动和挂载设置。' }, 422);
    return c.json(await input.preferences.configure(parsed.data));
  });
  app.get('/api/desktop/read-cache', async c => input.readCache ? c.json(await input.readCache.inspect()) : c.notFound());
  app.put('/api/desktop/read-cache', async c => {
    if (!input.readCache) return c.notFound();
    const parsed = readCacheSettingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_read_cache_settings', message: '容量须为 0—1048576 MiB 的整数，保留时间须为 0—2147483 小时的整数。' }, 422);
    return c.json(await input.readCache.configure(parsed.data));
  });
  app.delete('/api/desktop/read-cache', async c => input.readCache ? c.json(await input.readCache.clear()) : c.notFound());
  let networkUpdate = Promise.resolve();
  app.on(['PUT', 'PATCH'], '/api/desktop/network', async c => {
    const parsed = (c.req.method === 'PATCH' ? networkUpdateSchema : desktopNetworkSchema).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_network_settings', message: '请选择有效的访问范围，端口须为 0—65535 的整数。' }, 422);
    // Each page submits only its own fields. Merge inside the same update queue
    // so saving one entry cannot restore the other entry's earlier settings.
    const updated = networkUpdate.then(async () => {
      const settings = desktopNetworkSchema.parse({ ...await readDesktopNetworkSettings(input.directory), ...parsed.data });
      if (input.configureNetwork) await input.configureNetwork(settings);
      else await writePrivateJson(join(input.directory, 'network.json'), settings);
      return networkView();
    });
    networkUpdate = updated.then(() => {}, () => {});
    try { return c.json(await updated); }
    catch { return c.json({ error: 'network_failed', message: '监听地址未能切换，请检查端口是否被占用。原入口仍可使用。' }, 422); }
  });
  app.get('/api/desktop/mount-prerequisites', async c => c.json(await input.prerequisites.inspect()));
  app.post('/api/desktop/mount-prerequisites/install', async c => c.json(await input.prerequisites.installWinFsp()));
  app.get('/api/desktop/https', async c => c.json(await input.https.inspect()));
  app.post('/api/desktop/https/enable', async c => c.json(await input.https.enable()));
  app.post('/api/desktop/https/trust', async c => c.json(await input.https.trust()));
  app.delete('/api/desktop/https/file-size-limit', async c => c.json(await input.https.restoreFileSizeLimit()));
  app.delete('/api/desktop/https', async c => c.json(await input.https.disable()));
  app.post('/api/desktop/quit', async c => {
    let resume: void | (() => void) = undefined;
    let resumeMounts: void | (() => void) = undefined;
    const resumeWork = () => { if (typeof resumeMounts === 'function') resumeMounts(); if (typeof resume === 'function') resume(); };
    try { resume = await input.prepareQuit?.(); resumeMounts = await input.prepareShutdown?.(); await input.mounts.close(); }
    catch (error) { resumeWork(); return c.json({ error: 'mount_busy', message: error instanceof MountError ? error.message : '挂载未能正常卸载，后台仍在运行。请关闭占用程序后重试。' }, 409); }
    setTimeout(() => { void input.close().catch(() => { resumeWork(); console.error('MusicFS background shutdown failed; private data was preserved.'); }); }, 100);
    return c.json({ stopping: true }, 202);
  });
  return app;
}
