import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDesktopBackground } from '../src/hosts/desktop/launcher';
import { readDesktopNetworkSettings } from '../src/hosts/desktop/network';
import { createApi } from '../src/web/api';

const defaults = { managementAccess: 'local', managementPort: 0, davAccess: 'local', davPort: 0 } as const;

test('old shared ports migrate to WebDAV while each access scope is retained', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-network-settings-'));
  try {
    expect(await readDesktopNetworkSettings(directory)).toEqual(defaults);
    for (const access of ['local', 'lan'] as const) {
      await Bun.write(join(directory, 'network.json'), JSON.stringify({ access, port: 8787 }));
      expect(await readDesktopNetworkSettings(directory)).toEqual({ ...defaults, managementAccess: access, davAccess: access, davPort: 8787 });
    }
    await Bun.write(join(directory, 'network.json'), JSON.stringify({ managementAccess: 'local', davAccess: 'lan', port: 8787 }));
    expect(await readDesktopNetworkSettings(directory)).toEqual({ ...defaults, davAccess: 'lan', davPort: 8787 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('separate desktop settings, addresses, credentials and assigned ports survive restart; fallback moves only the occupied entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-network-'));
  const data = join(directory, 'data'); const resources = join(directory, 'resources');
  await mkdir(join(resources, 'web'), { recursive: true });
  await Bun.write(join(resources, 'web/index.html'), '<!doctype html><title>Network fixture</title>');
  let backend: Awaited<ReturnType<typeof startDesktopBackground>>;
  let blocker: ReturnType<typeof Bun.serve> | undefined;
  try {
    backend = await startDesktopBackground({ directory: data, resourcesDirectory: resources });
    const originalOrigin = backend!.origin; const originalDavOrigin = backend!.davOrigin;
    const credentialsText = await readFile(join(data, 'credentials.json'), 'utf8');
    const credentials = JSON.parse(credentialsText) as { adminToken: string; username: string; password: string };
    const auth = { Authorization: `Bearer ${credentials.adminToken}`, 'Content-Type': 'application/json' };
    const reader = { Authorization: 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64'), Depth: '1' };
    const api = createApi(credentials.adminToken, ((path: string | URL | Request, init?: RequestInit) => fetch(new URL(String(path), backend!.origin), init)) as typeof fetch);
    const initial = await api.desktopNetwork(new AbortController().signal);
    expect(initial.settings).toEqual(defaults); expect(initial.restartRequired).toBe(false);
    expect(initial.active.managementPort).not.toBe(initial.active.davPort);
    expect(initial.managementUrls).toEqual([originalOrigin + '/']); expect(initial.davUrls).toEqual([originalDavOrigin + '/dav/']);
    for (const [url, headers, status] of [
      [originalOrigin + '/dav/', reader, 404], [originalDavOrigin + '/api/status', auth, 404],
      [originalDavOrigin + '/', auth, 404], [originalDavOrigin + '/dav/', reader, 207],
      [originalDavOrigin + '/dav/', {}, 401]
    ] as const) {
      const response = await fetch(url, { method: url.endsWith('/dav/') ? 'PROPFIND' : 'GET', headers });
      expect(response.status).toBe(status); await response.body?.cancel();
    }
    // Saving the reader's fields does not move management or rewrite its configuration.
    const saved = await api.saveDesktopNetwork({ davAccess: 'lan' });
    expect(saved.settings).toEqual({ ...defaults, davAccess: 'lan' });
    expect(saved.active.managementPort).toBe(initial.active.managementPort); expect(saved.active.davPort).toBe(initial.active.davPort);
    expect(backend!.origin).toBe(originalOrigin); expect(backend!.davOrigin).toBe(originalDavOrigin);
    expect((await stat(join(data, 'network.json'))).mode & 0o777).toBe(0o600);
    const address = Object.values(networkInterfaces()).flat().find(item => item && !item.internal && item.family === 'IPv4')?.address;
    if (address) {
      const readerOrigin = `http://${address}:${saved.active.davPort}`;
      expect(saved.davUrls).toContain(readerOrigin + '/dav/'); expect(saved.managementUrls).toEqual([originalOrigin + '/']);
      for (const [path, status] of [['/dav/', 207], ['/api/status', 404], ['/api/access/ticket', 404], ['/__musicfs/identity', 404]] as const) {
        const response = await fetch(readerOrigin + path, { method: path === '/dav/' ? 'PROPFIND' : 'GET', headers: path === '/dav/' ? reader : auth });
        expect(response.status).toBe(status); await response.body?.cancel();
      }
    }
    await backend!.close(); backend = undefined;
    backend = await startDesktopBackground({ directory: data, resourcesDirectory: resources });
    expect(backend!.origin).toBe(originalOrigin); expect(backend!.davOrigin).toBe(originalDavOrigin);
    expect(await readFile(join(data, 'credentials.json'), 'utf8')).toBe(credentialsText);
    const management = await api.saveDesktopNetwork({ managementAccess: 'lan' });
    expect(management.settings.davAccess).toBe('lan'); expect(management.active.davPort).toBe(initial.active.davPort);
    // The management port also refuses DAV, even when both entries accept LAN clients.
    if (address) {
      const managerOrigin = `http://${address}:${management.active.managementPort}`;
      const allowed = await fetch(managerOrigin + '/api/status', { headers: auth }); expect(allowed.status).toBe(200); await allowed.body?.cancel();
      const wrong = await fetch(managerOrigin + '/dav/', { method: 'PROPFIND', headers: reader }); expect(wrong.status).toBe(404); await wrong.body?.cancel();
    }
    const invalid = await fetch(backend!.origin + '/api/desktop/network', { method: 'PATCH', headers: auth,
      body: JSON.stringify({ davPort: management.active.managementPort }) });
    expect(invalid.status).toBe(422); await invalid.body?.cancel();
    await api.saveDesktopNetwork({ davPort: initial.active.davPort });
    await backend!.close(); backend = undefined;
    blocker = Bun.serve({ hostname: '127.0.0.1', port: initial.active.davPort, fetch: () => new Response('occupied') });
    backend = await startDesktopBackground({ directory: data, resourcesDirectory: resources });
    expect(backend!.origin).toBe(originalOrigin); expect(backend!.davOrigin).not.toBe(originalDavOrigin);
    const fallback = await api.desktopNetwork(new AbortController().signal);
    expect(fallback.settings.davPort).toBe(initial.active.davPort); expect(fallback.active.davPort).not.toBe(initial.active.davPort); expect(fallback.restartRequired).toBe(true);
    const reset = await api.saveDesktopNetwork({ davPort: 0 });
    expect(reset.restartRequired).toBe(false); expect(backend!.origin).toBe(originalOrigin);
  } finally { await backend?.close(); await blocker?.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test('a legacy automatic playback port is recovered from old runtime metadata during upgrade', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-legacy-network-'));
  const resources = join(directory, 'resources'); const data = join(directory, 'data');
  await mkdir(join(resources, 'web'), { recursive: true }); await mkdir(data);
  await Bun.write(join(resources, 'web/index.html'), '<title>Migration fixture</title>');
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null) });
  const oldOrigin = `http://127.0.0.1:${reservation.port}`; await reservation.stop(true);
  const instanceId = crypto.randomUUID();
  await Bun.write(join(data, 'credentials.json'), JSON.stringify({ instanceId, adminToken: crypto.randomUUID() + crypto.randomUUID(), username: 'musicfs', password: crypto.randomUUID() + crypto.randomUUID() }));
  await Bun.write(join(data, 'network.json'), JSON.stringify({ managementAccess: 'local', davAccess: 'lan', port: 0 }));
  await Bun.write(join(data, 'runtime.json'), JSON.stringify({ pid: process.pid, instanceId, origin: oldOrigin }));
  let backend: Awaited<ReturnType<typeof startDesktopBackground>>;
  try {
    backend = await startDesktopBackground({ directory: data, resourcesDirectory: resources });
    expect(backend!.davOrigin).toBe(oldOrigin); expect(backend!.origin).not.toBe(oldOrigin);
    expect(await readDesktopNetworkSettings(data)).toEqual({ ...defaults, davAccess: 'lan' });
  } finally { await backend?.close(); await rm(directory, { recursive: true, force: true }); }
});
