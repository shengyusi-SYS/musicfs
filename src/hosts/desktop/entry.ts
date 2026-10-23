import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { DesktopNetworkSettings, DesktopNetworkView } from '../../contracts/desktop';
import type { ManagementTicket } from '../../contracts/management-auth';

export const credentialsSchema = z.object({ instanceId: z.uuid(), adminToken: z.string().min(32), username: z.literal('musicfs'), password: z.string().min(32) }).strict();
export const runtimeSchema = z.object({ pid: z.number().int().positive(), origin: z.string(), davOrigin: z.string().optional(), instanceId: z.uuid() }).strict();
export type DesktopCredentials = z.infer<typeof credentialsSchema>;
type DesktopRuntime = { runtime: z.infer<typeof runtimeSchema>; credentials: DesktopCredentials };

/** Authenticate the running process before using the addresses left on disk. */
export async function readDesktopRuntime(directory: string): Promise<DesktopRuntime | undefined> {
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
    return { runtime: identity, credentials };
  } catch { return; }
}

export async function desktopLogin(entry: DesktopRuntime): Promise<{ url: string; expiresAt?: string }> {
  const url = new URL(entry.runtime.origin);
  const response = await fetch(new URL('/api/access/ticket', url), { method: 'POST', headers: { Authorization: `Bearer ${entry.credentials.adminToken}` } });
  if (response.ok) {
    const ticket = await response.json() as ManagementTicket;
    url.hash = new URLSearchParams({ ticket: ticket.ticket }).toString();
    return { url: url.href, expiresAt: ticket.expiresAt };
  }
  await response.body?.cancel();
  // Compatibility with an already-running backend from before management sessions.
  if (response.status === 404) { url.hash = new URLSearchParams({ token: entry.credentials.adminToken }).toString(); return { url: url.href }; }
  throw new Error('后台已运行，登录链接未能建立，请重新运行 MusicFS。');
}

export async function configureDesktopEntry(directory: string, settings: Partial<DesktopNetworkSettings>): Promise<DesktopRuntime> {
  const entry = await readDesktopRuntime(directory);
  if (!entry) throw new Error('未找到运行中的 MusicFS，请先启动程序。');
  const response = await fetch(new URL('/api/desktop/network', entry.runtime.origin), {
    method: 'PATCH', headers: { Authorization: `Bearer ${entry.credentials.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(settings)
  });
  if (!response.ok) {
    const error = await response.json() as { message?: string };
    throw new Error(error.message ?? '网络设置未能保存，原入口仍可使用。');
  }
  await response.body?.cancel();
  const updated = await readDesktopRuntime(directory);
  if (!updated) throw new Error('网络设置已保存，请重新运行 MusicFS 查看当前入口。');
  return updated;
}

/** Public startup information contains a short-lived login link, never DAV credentials. */
export async function desktopEntry(directory: string) {
  const entry = await readDesktopRuntime(directory);
  if (!entry) throw new Error('未找到运行中的 MusicFS，请先启动程序。');
  const response = await fetch(new URL('/api/desktop/network', entry.runtime.origin), { headers: { Authorization: `Bearer ${entry.credentials.adminToken}` } });
  if (!response.ok) { await response.body?.cancel(); throw new Error('后台已运行，访问地址未能读取，请重新运行 MusicFS。'); }
  const network = await response.json() as DesktopNetworkView;
  return { origin: entry.runtime.origin, network, login: await desktopLogin(entry) };
}
