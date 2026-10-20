import { expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
    const invalid = await fetch(`${origin}/api/mounts`, { method: 'POST', headers: auth,
      body: JSON.stringify({ mountPoint: 'relative-path', source: { kind: 'local' } }) });
    expect(invalid.status).toBe(422); expect(await invalid.json()).toMatchObject({ error: 'invalid_mount' });
    if (process.platform === 'linux' && !await access('/dev/fuse').then(() => true, () => false)) {
      const attempt = await fetch(`${origin}/api/mounts`, { method: 'POST', headers: auth,
        body: JSON.stringify({ mountPoint: join(directory, 'music'), source: { kind: 'local' } }) });
      expect(attempt.status).toBe(201);
      const failed = await attempt.json() as { id: string; state: string; error: { code: string } };
      expect(failed).toMatchObject({ state: 'error', error: { code: 'dependency_missing' } });
      const unmounted = await fetch(`${origin}/api/mounts/${failed.id}/unmount`, { method: 'POST', headers: auth });
      expect(await unmounted.json()).toMatchObject({ state: 'stopped' });
      const removed = await fetch(`${origin}/api/mounts/${failed.id}`, { method: 'DELETE', headers: auth });
      expect(removed.status).toBe(204);
      expect(await (await fetch(`${origin}/api/mounts`, { headers: auth })).json()).toEqual([]);
    }
    let opened = '';
    const reuse = await launchDesktop({ command: [process.execPath, resolve('src/desktop.ts')], directory: data, resourcesDirectory: resources,
      browser: async url => { opened = url; } });
    expect(reuse).toEqual({ origin, reused: true });
    expect(new URLSearchParams(new URL(opened).hash.slice(1)).get('token')).toBe(token);
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

test('a click immediately after SIGKILL waits for the stale lock and restores one backend with the same credentials and endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-crash-'));
  const data = join(directory, 'data'); const resources = join(directory, 'resources');
  await mkdir(join(resources, 'web'), { recursive: true });
  await writeFile(join(resources, 'web', 'index.html'), '<!doctype html><title>Desktop crash fixture</title>');
  const command = [process.execPath, resolve('src/desktop.ts'), '--no-open', '--data', data, '--resources', resources];
  const original = Bun.spawn([...command, '--background'], { stdout: 'pipe', stderr: 'pipe' });
  let origin = ''; let token = ''; let recoveredBackend = false;
  try {
    const readyBy = Date.now() + 5_000;
    while (!await Bun.file(join(data, 'runtime.json')).exists() && Date.now() < readyBy) await Bun.sleep(25);
    const before = JSON.parse(await readFile(join(data, 'runtime.json'), 'utf8')) as { origin: string; pid: number };
    const credentials = await readFile(join(data, 'credentials.json'), 'utf8');
    token = (JSON.parse(credentials) as { adminToken: string }).adminToken; origin = before.origin;
    expect(before.pid).toBe(original.pid);
    const mounts = await fetch(`${origin}/api/mounts`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await mounts.json()).toEqual([]);
    original.kill('SIGKILL'); await original.exited;
    expect(await access(`${data}.lock`).then(() => true, () => false)).toBe(true);
    const click = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
    const clickedAt = Date.now();
    const code = await click.exited;
    if (code !== 0) throw new Error(await new Response(click.stderr).text());
    const recovered = JSON.parse(await readFile(join(data, 'runtime.json'), 'utf8')) as typeof before;
    origin = recovered.origin; recoveredBackend = true;
    expect(recovered.pid).not.toBe(before.pid); expect(recovered.pid).not.toBe(click.pid);
    expect(recovered.origin).toBe(before.origin);
    expect(Date.now() - clickedAt).toBeGreaterThan(15_000);
    expect(Date.now() - clickedAt).toBeLessThan(47_000);
    expect(await readFile(join(data, 'credentials.json'), 'utf8')).toBe(credentials);
    const identity = await fetch(`${origin}/__musicfs/identity`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await identity.json()).toMatchObject({ pid: recovered.pid, origin });
    const reusedAt = Date.now();
    expect(await launchDesktop({ command: [process.execPath, resolve('src/desktop.ts')], directory: data, resourcesDirectory: resources, openBrowser: false }))
      .toEqual({ origin, reused: true });
    expect(Date.now() - reusedAt).toBeLessThan(2_000);
    expect(JSON.parse(await readFile(join(data, 'runtime.json'), 'utf8')).pid).toBe(recovered.pid);
  } finally {
    if (original.exitCode === null) { original.kill('SIGKILL'); await original.exited; }
    if (recoveredBackend && origin && token) {
      const response = await fetch(`${origin}/api/desktop/quit`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
      if (response) {
        expect(response.status).toBe(202); await response.body?.cancel();
        const deadline = Date.now() + 5_000;
        while (await Bun.file(join(data, 'runtime.json')).exists() && Date.now() < deadline) await Bun.sleep(50);
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 55_000);

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
