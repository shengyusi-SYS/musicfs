import { readFile } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { DesktopNetworkSettings, DesktopNetworkView } from '../../contracts/desktop';
import { writePrivateJson } from './rclone-control';

const access = z.enum(['local', 'lan']); const port = z.number().int().min(0).max(65535);
const fields = z.object({ managementAccess: access, managementPort: port, davAccess: access, davPort: port }).strict();
export const desktopNetworkSchema = fields.refine(value => !value.managementPort || value.managementPort !== value.davPort,
  { message: '管理页面与 WebDAV 需要使用不同端口。' });
export const desktopNetworkUpdateSchema = fields.partial().refine(value => Object.keys(value).length > 0);
const assignedPorts = z.object({ managementPort: port, davPort: port }).strict();
const storedNetworkSchema = z.union([
  fields.extend({ assignedPorts: assignedPorts.optional() }).strict().transform(({ assignedPorts: ports, ...settings }) => ({ settings, assignedPorts: ports })),
  z.object({ managementAccess: access, davAccess: access, port }).strict().transform(value => ({
    settings: { managementAccess: value.managementAccess, managementPort: 0, davAccess: value.davAccess, davPort: value.port }, assignedPorts: undefined
  })),
  z.object({ access, port }).strict().transform(value => ({
    settings: { managementAccess: value.access, managementPort: 0, davAccess: value.access, davPort: value.port }, assignedPorts: undefined
  }))
]);

export async function readDesktopNetworkState(directory: string) {
  try { return storedNetworkSchema.parse(JSON.parse(await readFile(join(directory, 'network.json'), 'utf8'))); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {
      settings: { managementAccess: 'local', managementPort: 0, davAccess: 'local', davPort: 0 } as DesktopNetworkSettings, assignedPorts: undefined
    };
    throw new Error('本机网络设置无法读取，请保留数据并检查 network.json。');
  }
}
export const readDesktopNetworkSettings = async (directory: string): Promise<DesktopNetworkSettings> => (await readDesktopNetworkState(directory)).settings;

export async function saveDesktopNetworkSettings(directory: string, settings: DesktopNetworkSettings, active: DesktopNetworkSettings) {
  // Automatic ports retain their assigned addresses across normal restarts, too.
  await writePrivateJson(join(directory, 'network.json'), { ...settings, assignedPorts: { managementPort: active.managementPort, davPort: active.davPort } });
}

export function desktopNetworkView(settings: DesktopNetworkSettings, current: DesktopNetworkSettings): DesktopNetworkView {
  const { managementAccess, managementPort, davAccess, davPort } = current;
  const active = { managementAccess, managementPort, davAccess, davPort };
  const addresses = ['127.0.0.1'];
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) if (!address.internal && address.family === 'IPv4') addresses.push(address.address);
  }
  const urls = (scope: 'local' | 'lan', port: number, path: string) => [...new Set((scope === 'lan' ? addresses : addresses.slice(0, 1)).map(address => `http://${address}:${port}${path}`))];
  return { settings, active, machine: { name: hostname(), platform: process.platform }, managementUrls: urls(active.managementAccess, active.managementPort, '/'), davUrls: urls(active.davAccess, active.davPort, '/dav/'),
    restartRequired: settings.managementAccess !== active.managementAccess || settings.davAccess !== active.davAccess
      || settings.managementPort !== 0 && settings.managementPort !== active.managementPort || settings.davPort !== 0 && settings.davPort !== active.davPort };
}
