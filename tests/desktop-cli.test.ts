import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hasDesktopSession, parseDesktopArgs } from '../src/hosts/desktop/cli';

test('terminal modes detect SSH or a missing Linux desktop; help works before setup', async () => {
  expect(hasDesktopSession('linux', {})).toBe(false);
  expect(hasDesktopSession('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
  expect(hasDesktopSession('linux', { DISPLAY: ':0', SSH_CONNECTION: 'client 123 server 22' })).toBe(false);
  expect(hasDesktopSession('win32', { SSH_CLIENT: 'client 123 22' })).toBe(false);
  expect(hasDesktopSession('win32', {})).toBe(true);
  expect(parseDesktopArgs(['--dav-access', 'lan', '--dav-port', '8788']).network).toEqual({ davAccess: 'lan', davPort: 8788 });
  expect(() => parseDesktopArgs(['--management-port', ''])).toThrow('端口');
  expect(() => parseDesktopArgs(['--dav-access', 'all'])).toThrow('范围');
  expect(() => parseDesktopArgs(['--management-port', '8787', '--dav-port', '8787'])).toThrow('不同端口');
  const directory = join(tmpdir(), `musicfs-help-${crypto.randomUUID()}`);
  const help = Bun.spawn([process.execPath, resolve('src/desktop.ts'), '--help', '--data', directory], { stdout: 'pipe', stderr: 'pipe' });
  expect(await help.exited).toBe(0);
  const output = await new Response(help.stdout).text();
  expect(output).toContain('--headless'); expect(output).toContain('--foreground'); expect(output).toContain('--dav-port');
  expect(await access(directory).then(() => true, () => false)).toBe(false);
});

test('headless first access, CLI reconfiguration and foreground shutdown work without a browser or desktop helper', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs headless-'));
  const data = join(directory, 'data'); const resources = join(directory, 'resources'); const log = join(directory, 'stdout');
  await mkdir(join(resources, 'web'), { recursive: true });
  await Bun.write(join(resources, 'web', 'index.html'), '<title>Headless MusicFS</title>');
  const command = [process.execPath, resolve('src/desktop.ts'), '--data', data, '--resources', resources];
  const foreground = Bun.spawn([...command, '--foreground'], { stdout: Bun.file(log), stderr: 'pipe', env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' } });
  try {
    const deadline = Date.now() + 8_000;
    let output = '';
    while (Date.now() < deadline) {
      output = await readFile(log, 'utf8').catch(() => '');
      if (output.includes('Ctrl+C')) break;
      if (foreground.exitCode !== null) throw new Error(await new Response(foreground.stderr).text());
      await Bun.sleep(25);
    }
    expect(output).toContain('MusicFS 已启动'); expect(output).toContain('ssh -N -L');
    expect(output).toContain(`'${data}'`); expect(output).toContain(`'${resources}'`);
    const runtime = JSON.parse(await readFile(join(data, 'runtime.json'), 'utf8')) as { pid: number; origin: string; davOrigin: string };
    const credentials = JSON.parse(await readFile(join(data, 'credentials.json'), 'utf8')) as { adminToken: string; password: string };
    expect(output).toContain(runtime.davOrigin + '/dav/');
    expect(output).not.toContain(credentials.adminToken); expect(output).not.toContain(credentials.password);
    const login = new URL(output.match(/http:\/\/127\.0\.0\.1:\d+\/#ticket=\S+/)![0]);
    const exchange = await fetch(new URL('/api/access/exchange', login), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: new URLSearchParams(login.hash.slice(1)).get('ticket') }) });
    expect(exchange.status).toBe(200);
    const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!; await exchange.body?.cancel();
    const preferences = await fetch(new URL('/api/desktop/preferences', login), { headers: { Cookie: cookie } });
    expect(await preferences.json()).toMatchObject({ integration: { enabled: false, available: false } });
    const initial = await (await fetch(new URL('/api/desktop/network', login), { headers: { Cookie: cookie } })).json() as {
      active: { managementAccess: string; davAccess: string; davPort: number }; machine: { name: string; platform: string }
    };
    expect(initial.active).toMatchObject({ managementAccess: 'local', davAccess: 'local' });
    expect(initial.machine.name).toBeTruthy(); expect(initial.machine.platform).toBe(process.platform);
    const repeat = Bun.spawn([...command, '--headless', '--management-access', 'lan'], { stdout: 'pipe', stderr: 'pipe' });
    expect(await repeat.exited).toBe(0);
    const again = await new Response(repeat.stdout).text();
    expect(again).toContain('MusicFS 已在运行'); expect(again).not.toContain('ssh -N -L');
    const second = JSON.parse(await readFile(join(data, 'runtime.json'), 'utf8')) as typeof runtime;
    expect(second.pid).toBe(runtime.pid); expect(second.davOrigin).toBe(runtime.davOrigin);
    const headers = { Authorization: `Bearer ${credentials.adminToken}` };
    const updated = await (await fetch(new URL('/api/desktop/network', second.origin), { headers })).json() as typeof initial;
    expect(updated.active).toMatchObject({ managementAccess: 'lan', davAccess: 'local', davPort: initial.active.davPort });
    expect(again.match(/#ticket=\S+/)![0]).not.toBe(login.hash);
    const redundant = Bun.spawn([...command, '--foreground'], { stdout: 'pipe', stderr: 'pipe' });
    expect(await redundant.exited).toBe(0);
    expect(await new Response(redundant.stdout).text()).not.toContain('Ctrl+C');
    foreground.kill('SIGTERM'); expect(await foreground.exited).toBe(0);
    expect(await access(join(data, 'runtime.json')).then(() => true, () => false)).toBe(false);
  } finally {
    if (foreground.exitCode === null) { foreground.kill('SIGTERM'); await foreground.exited; }
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
