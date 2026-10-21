import { join } from 'node:path';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { DesktopNetworkSettings } from '../../contracts/desktop';
import type { MountManager } from '../../contracts/mounts';
import type { MountPrerequisites } from '../../contracts/mount-prerequisites';
import type { ReadCacheManager } from '../../contracts/read-cache';
import { desktopNetworkSchema, desktopNetworkView, readDesktopNetworkSettings } from './network';
import { MountError, writePrivateJson } from './rclone-control';
import { DesktopHttpsError, type createDesktopHttps } from './https';

const readCacheSettingsSchema = z.object({
  maxMiB: z.number().int().min(0).max(1_048_576),
  maxAgeHours: z.number().int().min(0).max(2_147_483)
}).strict();

/** Desktop capabilities never enter the shared music domains or Worker host. */
export function createDesktopHttp(input: {
  directory: string; adminToken: string; network: DesktopNetworkSettings; port: () => number;
  mounts: MountManager; prerequisites: MountPrerequisites;
  readCache?: ReadCacheManager;
  https: Awaited<ReturnType<typeof createDesktopHttps>>;
  prepareQuit?: () => Promise<void | (() => void)>;
  close: () => Promise<void>;
}) {
  const app = new Hono();
  app.use('/api/desktop/*', bearerAuth({ token: input.adminToken }), async (c, next) => {
    c.header('Cache-Control', 'no-store'); await next();
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof MountError || error instanceof DesktopHttpsError) return c.json({ error: error.code, message: error.message }, 422);
    return c.json({ error: 'desktop_failed', message: '本机操作未完成，请检查后台日志后重试。' }, 500);
  });
  const networkView = async () => desktopNetworkView(await readDesktopNetworkSettings(input.directory), input.network, input.port());
  app.get('/api/desktop/network', async c => c.json(await networkView()));
  app.get('/api/desktop/read-cache', async c => input.readCache ? c.json(await input.readCache.inspect()) : c.notFound());
  app.put('/api/desktop/read-cache', async c => {
    if (!input.readCache) return c.notFound();
    const parsed = readCacheSettingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_read_cache_settings', message: '容量须为 0—1048576 MiB 的整数，保留时间须为 0—2147483 小时的整数。' }, 422);
    return c.json(await input.readCache.configure(parsed.data));
  });
  app.delete('/api/desktop/read-cache', async c => input.readCache ? c.json(await input.readCache.clear()) : c.notFound());
  app.put('/api/desktop/network', async c => {
    const parsed = desktopNetworkSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_network_settings', message: '请选择本机或局域网访问，端口须为 0—65535 的整数。' }, 422);
    await writePrivateJson(join(input.directory, 'network.json'), parsed.data);
    return c.json(await networkView());
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
    try { resume = await input.prepareQuit?.(); await input.mounts.close(); }
    catch (error) { if (typeof resume === 'function') resume(); return c.json({ error: 'mount_busy', message: error instanceof MountError ? error.message : '挂载未能正常卸载，后台仍在运行。请关闭占用程序后重试。' }, 409); }
    setTimeout(() => { void input.close().catch(() => { if (typeof resume === 'function') resume(); console.error('MusicFS background shutdown failed; private data was preserved.'); }); }, 100);
    return c.json({ stopping: true }, 202);
  });
  return app;
}
