import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { DesktopNetworkSettings, DesktopNetworkView } from '../../contracts/desktop';

const access = z.enum(['local', 'lan']); const port = z.number().int().min(0).max(65535);
export const desktopNetworkSchema = z.object({ managementAccess: access, davAccess: access, port }).strict();
const storedNetworkSchema = z.union([desktopNetworkSchema,
  z.object({ access, port }).strict().transform(value => ({ managementAccess: value.access, davAccess: value.access, port: value.port }))]);

export async function readDesktopNetworkSettings(directory: string): Promise<DesktopNetworkSettings> {
  try { return storedNetworkSchema.parse(JSON.parse(await readFile(join(directory, 'network.json'), 'utf8'))); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { managementAccess: 'local', davAccess: 'local', port: 0 };
    throw new Error('本机网络设置无法读取，请保留数据并检查 network.json。');
  }
}

export function desktopNetworkView(settings: DesktopNetworkSettings, started: DesktopNetworkSettings, port: number): DesktopNetworkView {
  const origins = [`http://127.0.0.1:${port}`];
  if (started.managementAccess === 'lan' || started.davAccess === 'lan') {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (!address.internal && address.family === 'IPv4') origins.push(`http://${address.address}:${port}`);
      }
    }
  }
  const urls = (scope: 'local' | 'lan', path: string) => [...new Set((scope === 'lan' ? origins : origins.slice(0, 1)).map(origin => origin + path))];
  return { settings, active: { ...started, port }, managementUrls: urls(started.managementAccess, '/'), davUrls: urls(started.davAccess, '/dav/'),
    restartRequired: settings.managementAccess !== started.managementAccess || settings.davAccess !== started.davAccess || settings.port !== started.port || settings.port !== 0 && settings.port !== port };
}
