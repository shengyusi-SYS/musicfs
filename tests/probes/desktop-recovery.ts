/** On-demand process-crash acceptance; ordinary tests do not wait for a stale lock. */
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { launchDesktop } from '../../src/hosts/desktop/launcher';

test('a launch after SIGKILL restores one backend with the same credentials and endpoint', async () => {
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
    const click = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
    const code = await click.exited;
    if (code !== 0) throw new Error(await new Response(click.stderr).text());
    const recovered = JSON.parse(await readFile(join(data, 'runtime.json'), 'utf8')) as typeof before;
    origin = recovered.origin; recoveredBackend = true;
    expect(recovered.pid).not.toBe(before.pid); expect(recovered.pid).not.toBe(click.pid);
    expect(recovered.origin).toBe(before.origin);
    expect(await readFile(join(data, 'credentials.json'), 'utf8')).toBe(credentials);
    const identity = await fetch(`${origin}/__musicfs/identity`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await identity.json()).toMatchObject({ pid: recovered.pid, origin });
    expect(await launchDesktop({ command: [process.execPath, resolve('src/desktop.ts')], directory: data, resourcesDirectory: resources, openBrowser: false }))
      .toEqual({ origin, reused: true });
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

