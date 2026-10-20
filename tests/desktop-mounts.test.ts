import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createMountManager, MountError } from '../src/hosts/desktop/mounts';
import { createRcloneControl, writePrivateJson, type RcloneControl } from '../src/hosts/desktop/rclone-control';
import { createDesktopService } from '../src/hosts/desktop/service';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const localConnection = () => ({ url: 'http://127.0.0.1:12345/dav/', username: 'musicfs', password: 'local-secret' });

function fakeControl() {
  const mounted = new Map<string, string>();
  const remotes = new Map<string, Record<string, unknown>>();
  let mountCalls = 0; let closed = false; let busy = false;
  const control: RcloneControl = {
    async call<T>(method: string, parameters: Record<string, unknown> = {}) {
      let value: unknown = {};
      if (method === 'config/create') remotes.set(String(parameters.name), parameters.parameters as Record<string, unknown>);
      if (method === 'config/get') value = remotes.get(String(parameters.name)) ?? {};
      if (method === 'mount/types') value = { mountTypes: ['mount', 'cmount', 'nfsmount'] };
      if (method === 'mount/listmounts') value = { mountPoints: [...mounted].map(([MountPoint, Fs]) => ({ MountPoint, Fs })) };
      if (method === 'mount/mount') { mountCalls++; await Bun.sleep(20); mounted.set(String(parameters.mountPoint), String(parameters.fs)); value = { mountPoint: parameters.mountPoint }; }
      if (method === 'mount/unmount') { if (busy) throw new MountError('mount_busy', 'busy'); mounted.delete(String(parameters.mountPoint)); }
      return value as T;
    },
    async close() { closed = true; }
  };
  return { control, mountCalls: () => mountCalls, closed: () => closed, setBusy(value: boolean) { busy = value; } };
}

test('concurrent mount requests reuse one filesystem; recovered state and responses exclude credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-mounts-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const fake = fakeControl();
  const options = { directory: join(directory, 'state'), binary: 'unused', localConnection, control: fake.control, checkDependencies: async () => {} };
  const manager = await createMountManager(options);
  cleanup.push(() => manager.close());
  const input = { mountPoint: join(directory, 'music'), source: { kind: 'remote' as const, url: 'https://example.com/dav/', username: 'private-name', password: 'private-password' } };
  const [first, second] = await Promise.all([manager.mount(input), manager.mount(input)]);
  expect(first.state).toBe('mounted'); expect(first.id).toBe(second.id); expect(fake.mountCalls()).toBe(1);
  expect(JSON.stringify(first)).not.toContain('private-password'); expect(JSON.stringify(first)).not.toContain('private-name');
  const recovered = await createMountManager(options);
  expect((await recovered.list())[0]?.id).toBe(first.id);
  expect((await recovered.mount(input)).id).toBe(first.id); expect(fake.mountCalls()).toBe(1);
  expect((await stat(join(options.directory, 'mounts.json'))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(options.directory, 'mounts.json'), 'utf8')).toContain('private-password');
  expect((await manager.unmount(first.id)).state).toBe('stopped');
});

test('HTTP LAN sources remain valid and a changed local DAV endpoint requires normal remounting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-endpoint-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const fake = fakeControl();
  let localUrl = 'http://127.0.0.1:10101/dav/';
  const options = { directory: join(directory, 'state'), binary: 'unused', localConnection: () => ({ ...localConnection(), url: localUrl }),
    control: fake.control, checkDependencies: async () => {} };
  const manager = await createMountManager(options);
  cleanup.push(() => manager.close());
  const input = { mountPoint: join(directory, 'local'), source: { kind: 'local' as const } };
  const local = await manager.mount(input);
  const remote = await manager.mount({ mountPoint: join(directory, 'remote'), source: { kind: 'remote', url: 'http://192.168.1.100:8080/dav/', username: 'reader', password: 'secret' } });
  expect(local.state).toBe('mounted'); expect(remote.state).toBe('mounted');
  localUrl = 'http://127.0.0.1:20202/dav/';
  const recovered = await createMountManager(options);
  const status = await recovered.list();
  expect(status.find(item => item.id === local.id)).toMatchObject({ state: 'error', error: { code: 'remount_required' } });
  expect(status.find(item => item.id === remote.id)?.state).toBe('mounted');
  await expect(recovered.mount(input)).rejects.toMatchObject({ code: 'mount_busy' });
  expect((await recovered.unmount(local.id)).state).toBe('stopped');
  expect((await recovered.mount(input)).state).toBe('mounted');
  expect((await recovered.list()).find(item => item.id === local.id)?.state).toBe('mounted');
});

test('busy normal unmount keeps the owned mount and prevents backend termination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-busy-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const fake = fakeControl();
  const manager = await createMountManager({ directory: join(directory, 'state'), binary: 'unused', localConnection, control: fake.control, checkDependencies: async () => {} });
  cleanup.push(async () => { fake.setBusy(false); await manager.close(); });
  const mounted = await manager.mount({ mountPoint: join(directory, 'music'), source: { kind: 'local' } });
  fake.setBusy(true);
  await expect(manager.unmount(mounted.id)).rejects.toMatchObject({ code: 'mount_busy' });
  await expect(manager.close()).rejects.toMatchObject({ code: 'mount_busy' });
  expect(fake.closed()).toBe(false);
  expect((await manager.list())[0]).toMatchObject({ state: 'error', error: { code: 'mount_busy' } });
});

test('missing system dependencies remain diagnosable and do not block quitting an unmounted backend', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-dependency-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const fake = fakeControl();
  const manager = await createMountManager({ directory: join(directory, 'state'), binary: 'unused', localConnection, control: fake.control,
    checkDependencies: async () => { throw new MountError('dependency_missing', 'FUSE is not available'); } });
  const result = await manager.mount({ mountPoint: join(directory, 'music'), source: { kind: 'local' } });
  expect(result).toMatchObject({ state: 'error', error: { code: 'dependency_missing' } });
  expect(fake.mountCalls()).toBe(0); await manager.close(); expect(fake.closed()).toBe(true);
  await expect(manager.mount({ mountPoint: join(directory, 'other'), source: { kind: 'remote', url: 'https://user:password@example.com/dav/', username: '', password: '' } })).rejects.toMatchObject({ code: 'invalid_mount' });
});

test('rclone RC disk-full errors reach management HTTP without exposing private details or changing busy and dependency classification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-rc-errors-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const password = crypto.randomUUID();
  const privateUrl = 'https://private-user:private-password@example.invalid/private-dav/';
  let failure = ''; let running = true;
  const rc = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (request.headers.get('Authorization') !== `Basic ${btoa(`musicfs:${password}`)}`) return new Response(null, { status: 401 });
    const method = new URL(request.url).pathname;
    if (method === '/core/pid' && running) return Response.json({ pid: process.pid });
    if (method === '/mount/listmounts') return Response.json({ mountPoints: [] });
    if (method === '/core/quit') { running = false; return Response.json({}); }
    return Response.json({ error: `fusermount: ${failure}; ${privateUrl}` }, { status: 500 });
  } });
  cleanup.push(() => rc.stop(true));
  const rcDirectory = join(directory, 'rc'); await mkdir(rcDirectory);
  await writePrivateJson(join(rcDirectory, 'rclone-runtime.json'), { pid: process.pid, port: rc.port, password });
  const control = createRcloneControl({ directory: rcDirectory, binary: 'unused' });
  const manager = await createMountManager({ directory: join(directory, 'mounts'), binary: 'unused', localConnection,
    control, checkDependencies: async () => {} });
  const service = await createDesktopService({ directory: join(directory, 'service'), adminToken: 'test-admin',
    dav: { username: 'reader', password: 'test-reader' }, mounts: manager });
  cleanup.push(() => service.close());
  const http = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: service.app.fetch });
  cleanup.push(() => http.stop(true));
  const cases = [
    ['ENOSPC', 'disk_full'], ['no space left on device', 'disk_full'], ['disk full', 'disk_full'],
    ['device or resource busy', 'mount_busy'], ['executable file not found', 'dependency_missing']
  ] as const;
  for (const [index, [message, code]] of cases.entries()) {
    failure = message;
    await expect(control.call('config/create')).rejects.toMatchObject({ name: 'MountError', code });
    const response = await fetch(`http://127.0.0.1:${http.port}/api/mounts`, { method: 'POST',
      headers: { Authorization: 'Bearer test-admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mountPoint: join(directory, `music-${index}`), source: { kind: 'local' } }) });
    expect(response.status).toBe(201);
    const result = await response.json() as { state: string; error: { code: string; message: string } };
    expect(result).toMatchObject({ state: 'error', error: { code } });
    if (code === 'disk_full') { expect(result.error.message).toContain('空间不足'); expect(result.error.message).toContain('释放'); }
    expect(JSON.stringify(result)).not.toContain(privateUrl);
  }
});

const binary = resolve('dist/tools/rclone-v1.75.2-linux-amd64/rclone');
test.skipIf(process.platform !== 'linux' || !await Bun.file(binary).exists())('the actual bundled rclone RC process survives coordinator reconstruction and shuts down without a mount', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-rclone-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const first = createRcloneControl({ directory, binary });
  const second = createRcloneControl({ directory, binary });
  cleanup.push(() => first.close()); cleanup.push(() => second.close());
  const identity = await first.call<{ pid: number }>('core/pid');
  expect(identity.pid).toBeGreaterThan(0);
  expect(await second.call('core/pid')).toEqual(identity);
  expect(await second.call('mount/listmounts')).toEqual({ mountPoints: [] });
  expect((await second.call<{ mountTypes: string[] }>('mount/types')).mountTypes).toContain('mount');
  await first.call('config/create', { name: 'endpoint_contract', type: 'webdav',
    parameters: { url: 'http://192.168.1.100:8080/dav/', vendor: 'other', user: 'reader', pass: 'private-test-password' }, opt: { obscure: true, nonInteractive: true } });
  expect((await second.call<{ url: string }>('config/get', { name: 'endpoint_contract' })).url).toBe('http://192.168.1.100:8080/dav/');
  await second.call('config/delete', { name: 'endpoint_contract' });
  await second.close();
  expect(await Bun.file(join(directory, 'rclone-runtime.json')).exists()).toBe(false);
});
