import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDesktopBackground } from '../src/hosts/desktop/launcher';
import type { DesktopNetworkView } from '../src/contracts/desktop';

test('desktop network settings persist, activate after restart, and serve authenticated DAV on a non-loopback address', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-network-'));
  const data = join(directory, 'data'); const resources = join(directory, 'resources');
  await mkdir(join(resources, 'web'), { recursive: true });
  await Bun.write(join(resources, 'web/index.html'), '<!doctype html><title>Network settings fixture</title>');
  let backend: Awaited<ReturnType<typeof startDesktopBackground>>;
  let blocker: ReturnType<typeof Bun.serve> | undefined;
  try {
    backend = await startDesktopBackground({ directory: data, resourcesDirectory: resources });
    expect(backend).toBeDefined();
    const credentialsText = await readFile(join(data, 'credentials.json'), 'utf8');
    const credentials = JSON.parse(credentialsText) as { adminToken: string; username: string; password: string };
    const auth = { Authorization: `Bearer ${credentials.adminToken}`, 'Content-Type': 'application/json' };
    const reader = { Authorization: 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64') };
    let endpoint = `${backend!.origin}/api/desktop/network`;
    const denied = await fetch(endpoint, { headers: reader }); expect([400, 401]).toContain(denied.status); await denied.body?.cancel();
    const initial = await (await fetch(endpoint, { headers: auth })).json() as DesktopNetworkView;
    expect(initial.settings).toEqual({ access: 'local', port: 0 }); expect(initial.restartRequired).toBe(false);
    expect(initial.davUrls).toEqual([`${backend!.origin}/dav/`]);
    const invalid = await fetch(endpoint, { method: 'PUT', headers: auth, body: JSON.stringify({ access: 'lan', port: -1 }) });
    expect(invalid.status).toBe(422); await invalid.body?.cancel();
    const fixedPort = initial.active.port;
    const saved = await (await fetch(endpoint, { method: 'PUT', headers: auth, body: JSON.stringify({ access: 'lan', port: fixedPort }) })).json() as DesktopNetworkView;
    expect(saved.settings).toEqual({ access: 'lan', port: fixedPort }); expect(saved.active.access).toBe('local'); expect(saved.restartRequired).toBe(true);
    expect((await stat(join(data, 'network.json'))).mode & 0o777).toBe(0o600);
    await backend!.close(); backend = undefined;
    backend = await startDesktopBackground({ directory: data, resourcesDirectory: resources });
    endpoint = `${backend!.origin}/api/desktop/network`;
    const active = await (await fetch(endpoint, { headers: auth })).json() as DesktopNetworkView;
    expect(active.active).toEqual({ access: 'lan', port: fixedPort }); expect(active.restartRequired).toBe(false);
    expect(await readFile(join(data, 'credentials.json'), 'utf8')).toBe(credentialsText);
    const address = Object.values(networkInterfaces()).flat().find(item => item && !item.internal && item.family === 'IPv4')?.address;
    if (address) {
      const origin = `http://${address}:${fixedPort}`;
      expect(active.davUrls).toContain(`${origin}/dav/`);
      const listing = await fetch(`${origin}/dav/`, { method: 'PROPFIND', headers: { ...reader, Depth: '1' } });
      expect(listing.status).toBe(207); expect(await listing.text()).toContain('DAV:');
      const management = await fetch(`${origin}/api/status`, { headers: reader });
      expect([400, 401]).toContain(management.status); await management.body?.cancel();
    }
    // An unavailable chosen port still leaves a usable settings page, and
    // reports that the requested setting has not taken effect.
    await backend!.close(); backend = undefined;
    blocker = Bun.serve({ hostname: '0.0.0.0', port: fixedPort, fetch: () => new Response('occupied') });
    backend = await startDesktopBackground({ directory: data, resourcesDirectory: resources });
    expect(backend!.origin).not.toBe(`http://127.0.0.1:${fixedPort}`);
    const fallback = await (await fetch(`${backend!.origin}/api/desktop/network`, { headers: auth })).json() as DesktopNetworkView;
    expect(fallback.settings.port).toBe(fixedPort); expect(fallback.active.port).not.toBe(fixedPort); expect(fallback.restartRequired).toBe(true);
    const reset = await fetch(`${backend!.origin}/api/desktop/network`, { method: 'PUT', headers: auth, body: JSON.stringify({ access: 'local', port: 0 }) });
    expect(reset.status).toBe(200); await reset.body?.cancel();
  } finally {
    await backend?.close(); await blocker?.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
