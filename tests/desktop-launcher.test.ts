import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { launchDesktop, startDesktopBackground } from '../src/hosts/desktop/launcher';

test('click launchers exit while one authenticated background survives; repeated launch reuses its credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-launcher-'));
  const data = join(directory, 'data'); const resources = join(directory, 'resources');
  await mkdir(join(resources, 'web'), { recursive: true });
  await writeFile(join(resources, 'web', 'index.html'), '<!doctype html><title>Desktop lifecycle fixture</title>');
  let origin = ''; let token = '';
  try {
    const command = [process.execPath, resolve('src/desktop.ts'), '--no-open', '--data', data, '--resources', resources];
    const children = [Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' }), Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })];
    const codes = await Promise.all(children.map(child => child.exited));
    if (codes.some(code => code !== 0)) throw new Error((await Promise.all(children.map(child => new Response(child.stderr).text()))).join('\n'));
    const runtime = JSON.parse(await readFile(join(data, 'runtime.json'), 'utf8')) as { origin: string; pid: number };
    const credentials = JSON.parse(await readFile(join(data, 'credentials.json'), 'utf8')) as { adminToken: string; password: string };
    origin = runtime.origin; token = credentials.adminToken;
    expect(credentials.adminToken).not.toBe(credentials.password);
    expect((await stat(join(data, 'credentials.json'))).mode & 0o777).toBe(0o600);
    const unauthorized = await fetch(`${origin}/api/status`); expect(unauthorized.status).toBe(401); await unauthorized.body?.cancel();
    const status = await fetch(`${origin}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await status.json()).toMatchObject({ host: 'desktop' });
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const mounts = await fetch(`${origin}/api/mounts`, { headers: auth });
    expect(await mounts.json()).toEqual([]);
    let opened = '';
    const reuse = await launchDesktop({ command: [process.execPath, resolve('src/desktop.ts')], directory: data, resourcesDirectory: resources,
      browser: async url => { opened = url; } });
    expect(reuse).toEqual({ origin, reused: true });
    const fragment = new URLSearchParams(new URL(opened).hash.slice(1));
    expect(fragment.get('ticket')).toBeTruthy(); expect(fragment.has('token')).toBe(false);
    const exchange = await fetch(new URL('/api/access/exchange', origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: fragment.get('ticket') }) });
    expect(exchange.status).toBe(200); await exchange.body?.cancel();
    const preferencesUrl = new URL('/api/desktop/preferences', origin);
    const preferences = await (await fetch(preferencesUrl, { headers: auth })).json() as { settings: { launchAtLogin: boolean; openOnLaunch: boolean; openOnLogin: boolean; autoMount: boolean; retryAutoMount: boolean } };
    expect(preferences.settings).toEqual({ launchAtLogin: true, openOnLaunch: true, openOnLogin: false, autoMount: true, retryAutoMount: true });
    const saved = await fetch(preferencesUrl, { method: 'PUT', headers: auth, body: JSON.stringify({ ...preferences.settings, openOnLaunch: false, openOnLogin: true }) });
    expect(saved.status).toBe(200); await saved.body?.cancel();
    let browserCalls = 0;
    const launch = { command: [process.execPath, resolve('src/desktop.ts')], directory: data, resourcesDirectory: resources,
      browser: async () => { browserCalls++; } };
    await launchDesktop(launch); expect(browserCalls).toBe(0);
    await launchDesktop({ ...launch, loginStartup: true }); expect(browserCalls).toBe(1);
    expect(JSON.parse(await readFile(join(data, 'runtime.json'), 'utf8')).pid).toBe(runtime.pid);
    expect(await readFile(join(data, 'launcher.log'), 'utf8')).not.toContain(token);
    expect(await readFile(join(data, 'launcher.log'), 'utf8')).not.toContain(credentials.password);
    const redundant = Bun.spawn([...command, '--background'], { stdout: 'pipe', stderr: 'pipe' });
    try {
      const exit = await Promise.race([redundant.exited, Bun.sleep(3_000).then(() => 'still-running' as const)]);
      expect(exit).toBe(0);
      expect(JSON.parse(await readFile(join(data, 'runtime.json'), 'utf8')).pid).toBe(runtime.pid);
    } finally { if (redundant.exitCode === null) { redundant.kill('SIGKILL'); await redundant.exited; } }
  } finally {
    if (origin && token) {
      const stop = await fetch(`${origin}/api/desktop/quit`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      expect(stop.status).toBe(202); await stop.body?.cancel();
      const deadline = Date.now() + 5_000;
      while (await Bun.file(join(data, 'runtime.json')).exists() && Date.now() < deadline) await Bun.sleep(50);
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 25_000);

test('residual same-instance metadata reuses the old port and an occupied port falls back to a usable management endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-recovery-'));
  const data = join(directory, 'data'); const resources = join(directory, 'resources');
  await mkdir(join(resources, 'web'), { recursive: true });
  await writeFile(join(resources, 'web', 'index.html'), '<!doctype html><title>Desktop recovery fixture</title>');
  let backend: Awaited<ReturnType<typeof startDesktopBackground>>;
  let blocker: ReturnType<typeof Bun.serve> | undefined;
  try {
    backend = await startDesktopBackground({ directory: data, resourcesDirectory: resources });
    expect(backend).toBeDefined();
    const originalOrigin = backend!.origin;
    const residual = await readFile(join(data, 'runtime.json'), 'utf8');
    await backend!.close(); backend = undefined;
    // Recreate the durable metadata left by a crash, without killing an actual filesystem owner.
    await writeFile(join(data, 'runtime.json'), residual, { mode: 0o600 });
    backend = await startDesktopBackground({ directory: data, resourcesDirectory: resources });
    expect(backend?.origin).toBe(originalOrigin);
    await backend!.close(); backend = undefined;
    await writeFile(join(data, 'runtime.json'), residual, { mode: 0o600 });
    blocker = Bun.serve({ hostname: '127.0.0.1', port: Number(new URL(originalOrigin).port), fetch: () => new Response('occupied') });
    backend = await startDesktopBackground({ directory: data, resourcesDirectory: resources });
    expect(backend).toBeDefined(); expect(backend!.origin).not.toBe(originalOrigin);
    const credentials = JSON.parse(await readFile(join(data, 'credentials.json'), 'utf8')) as { adminToken: string };
    const status = await fetch(`${backend!.origin}/api/status`, { headers: { Authorization: `Bearer ${credentials.adminToken}` } });
    expect(await status.json()).toMatchObject({ host: 'desktop' });
    expect(await (await fetch(originalOrigin)).text()).toBe('occupied');
  } finally {
    await backend?.close(); await blocker?.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
