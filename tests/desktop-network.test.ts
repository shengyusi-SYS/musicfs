import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { startDesktopBackground } from '../src/hosts/desktop/launcher';
import type { DesktopNetworkView } from '../src/contracts/desktop';
import { readDesktopNetworkSettings } from '../src/hosts/desktop/network';

test('existing shared scopes retain their range and new settings persist independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-network-settings-'));
  try {
    expect(await readDesktopNetworkSettings(directory)).toEqual({ managementAccess: 'local', davAccess: 'local', port: 0 });
    for (const access of ['local', 'lan'] as const) {
      await Bun.write(join(directory, 'network.json'), JSON.stringify({ access, port: 8787 }));
      expect(await readDesktopNetworkSettings(directory)).toEqual({ managementAccess: access, davAccess: access, port: 8787 });
    }
    await Bun.write(join(directory, 'network.json'), JSON.stringify({ managementAccess: 'local', davAccess: 'lan', port: 8787 }));
    expect(await readDesktopNetworkSettings(directory)).toEqual({ managementAccess: 'local', davAccess: 'lan', port: 8787 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('desktop network settings apply immediately, persist, and serve authenticated DAV on a non-loopback address', async () => {
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
    expect(initial.settings).toEqual({ managementAccess: 'local', davAccess: 'local', port: 0 }); expect(initial.restartRequired).toBe(false);
    expect(initial.davUrls).toEqual([`${backend!.origin}/dav/`]);
    expect(initial.managementUrls).toEqual([`${backend!.origin}/`]);
    const invalid = await fetch(endpoint, { method: 'PUT', headers: auth, body: JSON.stringify({ managementAccess: 'local', davAccess: 'lan', port: -1 }) });
    expect(invalid.status).toBe(422); await invalid.body?.cancel();
    const fixedPort = initial.active.port;
    const scopes = { managementAccess: 'local', davAccess: 'lan', port: fixedPort } as const;
    const saved = await (await fetch(endpoint, { method: 'PUT', headers: auth, body: JSON.stringify(scopes) })).json() as DesktopNetworkView;
    expect(saved.settings).toEqual(scopes); expect(saved.active).toEqual(scopes); expect(saved.restartRequired).toBe(false);
    expect((await stat(join(data, 'network.json'))).mode & 0o777).toBe(0o600);
    await backend!.close(); backend = undefined;
    backend = await startDesktopBackground({ directory: data, resourcesDirectory: resources });
    endpoint = `${backend!.origin}/api/desktop/network`;
    const active = await (await fetch(endpoint, { headers: auth })).json() as DesktopNetworkView;
    expect(active.active).toEqual(scopes); expect(active.restartRequired).toBe(false);
    expect(await readFile(join(data, 'credentials.json'), 'utf8')).toBe(credentialsText);
    const address = Object.values(networkInterfaces()).flat().find(item => item && !item.internal && item.family === 'IPv4')?.address;
    if (address) {
      const origin = `http://${address}:${fixedPort}`;
      expect(active.davUrls).toContain(`${origin}/dav/`);
      expect(active.managementUrls).toEqual([`${backend!.origin}/`]);
      const noCredentials = await fetch(`${origin}/dav/`, { method: 'PROPFIND' });
      expect(noCredentials.status).toBe(401); await noCredentials.body?.cancel();
      const listing = await fetch(`${origin}/dav/`, { method: 'PROPFIND', headers: { ...reader, Depth: '1' } });
      expect(listing.status).toBe(207); expect(await listing.text()).toContain('DAV:');
      // Even valid management credentials cannot bypass socket scope.
      for (const path of ['/', '/api/status', '/api/access/status', '/api/access/ticket', '/api/desktop/network', '/__musicfs/identity']) {
        const management = await fetch(origin + path, { headers: { ...auth, 'X-Forwarded-For': '127.0.0.1' } });
        expect(management.status).toBe(403); await management.body?.cancel();
      }
      // Bun fetch changes its connection target when Host is overridden. Use a real
      // TCP connection so the forged header cannot silently turn this into a local request.
      const forgedHost = await new Promise<number>((resolve, reject) => {
        let response = '';
        const socket = connect({ host: address, port: fixedPort }, () => socket.write(
          `GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:${fixedPort}\r\nAuthorization: Bearer ${credentials.adminToken}\r\nX-Forwarded-For: 127.0.0.1\r\nConnection: close\r\n\r\n`));
        socket.on('data', chunk => { response += chunk.toString(); });
        socket.once('error', reject); socket.once('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1])));
      });
      expect(forgedHost).toBe(403);
      // Swap the scopes without changing the socket or the saved playback address.
      const switched = await (await fetch(endpoint, { method: 'PUT', headers: auth,
        body: JSON.stringify({ managementAccess: 'lan', davAccess: 'local', port: fixedPort }) })).json() as DesktopNetworkView;
      expect(switched.active.port).toBe(fixedPort); expect(switched.managementUrls).toContain(origin + '/');
      expect(switched.davUrls).toEqual([`${backend!.origin}/dav/`]);
      const managed = await fetch(origin + '/api/status', { headers: auth }); expect(managed.status).toBe(200); await managed.body?.cancel();
      const readerCannotManage = await fetch(origin + '/api/status', { headers: reader });
      expect([400, 401]).toContain(readerCannotManage.status); await readerCannotManage.body?.cancel();
      const davBlocked = await fetch(origin + '/dav/', { method: 'PROPFIND', headers: reader });
      expect(davBlocked.status).toBe(403); await davBlocked.body?.cancel();
      const localDav = await fetch(backend!.origin + '/dav/', { method: 'PROPFIND', headers: { ...reader, Depth: '0' } });
      expect(localDav.status).toBe(207); await localDav.body?.cancel();
      const restored = await fetch(endpoint, { method: 'PUT', headers: auth, body: JSON.stringify(scopes) });
      expect(restored.status).toBe(200); await restored.body?.cancel();
    }
    // An unavailable chosen port still leaves a usable settings page, and
    // reports that the requested setting has not taken effect.
    await backend!.close(); backend = undefined;
    blocker = Bun.serve({ hostname: '0.0.0.0', port: fixedPort, fetch: () => new Response('occupied') });
    backend = await startDesktopBackground({ directory: data, resourcesDirectory: resources });
    expect(backend!.origin).not.toBe(`http://127.0.0.1:${fixedPort}`);
    const fallback = await (await fetch(`${backend!.origin}/api/desktop/network`, { headers: auth })).json() as DesktopNetworkView;
    expect(fallback.settings.port).toBe(fixedPort); expect(fallback.active.port).not.toBe(fixedPort); expect(fallback.restartRequired).toBe(true);
    const reset = await fetch(`${backend!.origin}/api/desktop/network`, { method: 'PUT', headers: auth, body: JSON.stringify({ managementAccess: 'local', davAccess: 'local', port: 0 }) });
    expect(reset.status).toBe(200); await reset.body?.cancel();
  } finally {
    await backend?.close(); await blocker?.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
