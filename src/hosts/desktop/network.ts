import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { DesktopNetworkSettings, DesktopNetworkView } from '../../contracts/desktop';

export const desktopNetworkSchema = z.object({ access: z.enum(['local', 'lan']), port: z.number().int().min(0).max(65535) }).strict();

export async function readDesktopNetworkSettings(directory: string): Promise<DesktopNetworkSettings> {
  try { return desktopNetworkSchema.parse(JSON.parse(await readFile(join(directory, 'network.json'), 'utf8'))); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { access: 'local', port: 0 };
    throw new Error('本机网络设置无法读取，请保留数据并检查 network.json。');
  }
}

export function desktopNetworkView(settings: DesktopNetworkSettings, started: DesktopNetworkSettings, port: number): DesktopNetworkView {
  const davUrls = [`http://127.0.0.1:${port}/dav/`];
  if (started.access === 'lan') {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (!address.internal && address.family === 'IPv4') davUrls.push(`http://${address.address}:${port}/dav/`);
      }
    }
  }
  return { settings, active: { access: started.access, port }, davUrls: [...new Set(davUrls)],
    restartRequired: settings.access !== started.access || settings.port !== started.port || settings.port !== 0 && settings.port !== port };
}
