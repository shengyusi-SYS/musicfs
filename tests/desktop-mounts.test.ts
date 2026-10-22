import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createMountManager, MountError } from '../src/hosts/desktop/mounts';
import { createRcloneControl, writePrivateJson, type RcloneControl } from '../src/hosts/desktop/rclone-control';
import { createDesktopService } from '../src/hosts/desktop/service';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const localConnection = () => ({ url: 'http://127.0.0.1:12345/dav/', username: 'musicfs', password: 'local-secret' });

test('old cache defaults upgrade once for local and remote mounts while custom periods remain intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-mount-retention-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const fake = fakeControl();
  const sources = [{ kind: 'local' as const }, { kind: 'remote' as const, url: 'http://fixture/dav/', username: 'reader', password: 'fixture' }, { kind: 'local' as const }];
  const records = sources.map((source, index) => {
    const settings = { directoryCacheSeconds: index === 2 ? 900 : 300, fileCacheMaxAgeHours: index === 2 ? 72 : 168, fileCacheMaxMiB: 64 };
    const mountPoint = join(directory, String(index));
    return { input: { mountPoint, source, ...settings }, mayBeMounted: false,
      view: { id: crypto.randomUUID(), name: 'Saved', mountPoint, source, ...settings, state: 'stopped' } };
  });
  await writePrivateJson(join(directory, 'mounts.json'), records);
  const options = { directory, binary: 'unused', localConnection, control: fake.control, manageControl: false, checkDependencies: async () => {} };
  let manager = await createMountManager(options);
  try {
    expect((await manager.list()).map(item => [item.directoryCacheSeconds, item.fileCacheMaxAgeHours, item.fileCacheMaxMiB]))
      .toEqual([[31536000, 8760, 64], [2592000, 8760, 64], [900, 72, 64]]);
    await manager.configureCache(records[0]!.view.id, { directoryCacheSeconds: 300, fileCacheMaxAgeHours: 168 });
    await manager.close(); manager = await createMountManager(options);
    expect((await manager.list())[0]).toMatchObject({ directoryCacheSeconds: 300, fileCacheMaxAgeHours: 168 });
  } finally { await manager.close(); }
});

function fakeControl() {
  const mounted = new Map<string, string>();
  const remotes = new Map<string, Record<string, unknown>>();
  const calls: { method: string; parameters: Record<string, unknown> }[] = [];
  let statistics: unknown = { opt: { CacheMode: 3 }, diskCache: { path: '/test/cache', bytesUsed: 0, files: 0 } };
  let mountCalls = 0; let closed = false; let busy = false; let listFailure = false;
  const control: RcloneControl = {
    async call<T>(method: string, parameters: Record<string, unknown> = {}) {
      calls.push({ method, parameters: structuredClone(parameters) });
      let value: unknown = {};
      if (method === 'config/create') remotes.set(String(parameters.name), parameters.parameters as Record<string, unknown>);
      if (method === 'config/get') value = remotes.get(String(parameters.name)) ?? {};
      if (method === 'operations/list' && listFailure) throw new MountError('mount_failed', 'Cannot list remote');
      if (method === 'mount/types') value = { mountTypes: ['mount', 'cmount', 'nfsmount'] };
      if (method === 'mount/listmounts') value = { mountPoints: [...mounted].map(([MountPoint, Fs]) => ({ MountPoint, Fs })) };
      if (method === 'vfs/stats') value = statistics;
      if (method === 'mount/mount') { mountCalls++; await Bun.sleep(20); mounted.set(String(parameters.mountPoint), String(parameters.fs)); value = { mountPoint: parameters.mountPoint }; }
      if (method === 'mount/unmount') { if (busy) throw new MountError('mount_busy', 'busy'); mounted.delete(String(parameters.mountPoint)); }
      return value as T;
    },
    async removeRemote(name) { remotes.delete(name); },
    async close() { closed = true; }
  };
  return { control, remotes, calls, mountCalls: () => mountCalls, closed: () => closed,
    clearMounts() { mounted.clear(); },
    setStatistics(value: unknown) { statistics = value; },
    setBusy(value: boolean) { busy = value; }, setListFailure(value: boolean) { listFailure = value; } };
}

test('mount names become native volume labels; renaming keeps identity and cache and respects busy files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-mount-name-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const fake = fakeControl();
  const options = { directory: join(directory, 'state'), binary: 'unused', localConnection,
    control: fake.control, checkDependencies: async () => {} };
  const manager = await createMountManager(options);
  cleanup.push(() => manager.close());
  const mount = await manager.mount({ mountPoint: join(directory, 'music'), source: { kind: 'local' } });
  const native = () => fake.calls.filter(call => call.method === 'mount/mount').at(-1)!.parameters;
  expect(mount.name).toBe('MusicFS');
  expect(native().mountOpt).toMatchObject({ VolumeName: 'MusicFS' });
  const namespace = native().fs;
  const renamed = await manager.rename(mount.id, '我的音乐');
  expect(renamed).toMatchObject({ id: mount.id, name: '我的音乐', state: 'mounted' });
  expect(native()).toMatchObject({ fs: namespace, mountOpt: { VolumeName: '我的音乐' } });
  const saved = JSON.parse(await readFile(join(options.directory, 'mounts.json'), 'utf8'));
  expect(saved[0].input.name).toBe('我的音乐');
  const recovered = await createMountManager(options);
  expect((await recovered.list())[0]?.name).toBe('我的音乐');
  fake.setBusy(true);
  await expect(manager.rename(mount.id, '另一个名称')).rejects.toMatchObject({ code: 'mount_busy' });
  expect((await manager.list())[0]).toMatchObject({ name: '我的音乐', error: { code: 'mount_busy' } });
  fake.setBusy(false);
  await manager.unmount(mount.id);
  const mountsBefore = fake.mountCalls();
  expect(await manager.rename(mount.id, '本地乐库')).toMatchObject({ name: '本地乐库', state: 'stopped' });
  expect(fake.mountCalls()).toBe(mountsBefore);
  await manager.remount(mount.id);
  expect(native()).toMatchObject({ fs: namespace, mountOpt: { VolumeName: '本地乐库' } });
});

test('unchanged and recovered mount status leaves the saved file untouched; a disappeared mount is persisted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-mount-status-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const fake = fakeControl();
  const options = { directory: join(directory, 'state'), binary: 'unused', localConnection,
    control: fake.control, checkDependencies: async () => {} };
  const manager = await createMountManager(options);
  cleanup.push(() => manager.close());
  const mount = await manager.mount({ mountPoint: join(directory, 'music'), source: { kind: 'local' } });
  const statePath = join(options.directory, 'mounts.json');
  const previousTime = new Date('2000-01-01T00:00:00Z');
  await utimes(statePath, previousTime, previousTime);
  const recovered = await createMountManager(options);
  for (const current of [manager, manager, recovered]) {
    expect((await current.list())[0]?.state).toBe('mounted');
    expect((await stat(statePath)).mtimeMs).toBe(previousTime.getTime());
  }
  fake.clearMounts();
  expect((await recovered.list())[0]).toMatchObject({ id: mount.id, state: 'stopped' });
  const [saved] = JSON.parse(await readFile(statePath, 'utf8'));
  expect(saved).toMatchObject({ mayBeMounted: false, view: { id: mount.id, state: 'stopped' } });
});

test('cache status separates configured and native modes, samples only the selected VFS, and stays inactive without rclone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-cache-status-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const fake = fakeControl();
  const manager = await createMountManager({ directory: join(directory, 'state'), binary: 'unused', localConnection,
    control: fake.control, checkDependencies: async () => {} });
  cleanup.push(() => manager.close());
  const mount = await manager.mount({ mountPoint: join(directory, 'music'), source: { kind: 'local' } });
  const name = `musicfs_${mount.id.replaceAll('-', '')}`;
  const path = join(directory, 'state', 'cache', 'vfs', name);
  fake.setStatistics({ fs: 'https://private-user:private-password@example.invalid/',
    opt: { CacheMode: 3, secret: 'private-password' }, diskCache: { path, bytesUsed: 32768, files: 2, private: 'private-password' } });
  const status = await manager.cacheStatus(mount.id);
  expect(status).toMatchObject({ mountId: mount.id, configuredMode: 'full', actualMode: 'full', state: 'active', directory: path,
    bytesUsed: 32768, files: 2, message: null });
  expect(Number.isFinite(Date.parse(status.sampledAt))).toBe(true);
  expect(JSON.stringify(status)).not.toContain('private-password');
  expect(fake.calls.filter(call => call.method === 'vfs/stats').at(-1)?.parameters).toEqual({ fs: `${name}:` });
  fake.setStatistics({ opt: { CacheMode: 'off' } });
  expect(await manager.cacheStatus(mount.id)).toMatchObject({ configuredMode: 'full', actualMode: 'off', bytesUsed: null, files: null });
  await manager.unmount(mount.id);
  const before = fake.calls.length;
  expect(await manager.cacheStatus(mount.id)).toMatchObject({ state: 'inactive', actualMode: null, directory: path, bytesUsed: null, files: null });
  expect(fake.calls).toHaveLength(before);
});

test('read-cache clearing preserves busy mounts and clears only the selected namespace before a normal remount', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-cache-clear-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, 'state');
  const fake = fakeControl();
  const manager = await createMountManager({ directory: state, binary: 'unused', localConnection,
    control: fake.control, checkDependencies: async () => {} });
  cleanup.push(async () => { fake.setBusy(false); await manager.close(); });
  const first = await manager.mount({ mountPoint: join(directory, 'first'), source: { kind: 'local' }, fileCacheMaxMiB: 64 });
  const second = await manager.mount({ mountPoint: join(directory, 'second'), source: { kind: 'local' } });
  const fragment = (id: string, kind = 'vfs') => join(state, 'cache', kind, `musicfs_${id.replaceAll('-', '')}`, 'track');
  for (const id of [first.id, second.id]) for (const kind of ['vfs', 'vfsMeta']) {
    const path = fragment(id, kind); await mkdir(join(path, '..'), { recursive: true }); await Bun.write(path, 'cached-fragment');
  }
  fake.setBusy(true);
  await expect(manager.clearCache(first.id)).rejects.toMatchObject({ code: 'mount_busy' });
  expect(await Bun.file(fragment(first.id)).text()).toBe('cached-fragment');
  expect((await manager.list()).find(mount => mount.id === first.id)?.fileCacheMaxMiB).toBe(64);
  expect(fake.mountCalls()).toBe(2);
  fake.setBusy(false);
  expect(await manager.clearCache(first.id)).toMatchObject({ id: first.id, state: 'mounted', fileCacheMaxMiB: 64 });
  expect(fake.mountCalls()).toBe(3);
  for (const kind of ['vfs', 'vfsMeta']) {
    expect(await Bun.file(fragment(first.id, kind)).exists()).toBe(false);
    expect(await Bun.file(fragment(second.id, kind)).text()).toBe('cached-fragment');
  }
  await manager.unmount(first.id);
  const cached = fragment(first.id); await mkdir(join(cached, '..'), { recursive: true }); await Bun.write(cached, 'new-fragment');
  const before = fake.calls.length;
  expect(await manager.clearCache(first.id)).toMatchObject({ state: 'stopped', fileCacheMaxMiB: 64 });
  expect(await Bun.file(cached).exists()).toBe(false); expect(fake.calls).toHaveLength(before);
  expect(await Bun.file(fragment(second.id)).text()).toBe('cached-fragment');
});

test('local directory cache defaults to a year and change only after a normal unmount', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-mount-cache-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const fake = fakeControl();
  const legacyInput = { mountPoint: join(directory, 'music'), source: { kind: 'local' as const } };
  await mkdir(join(directory, 'state'));
  await writePrivateJson(join(directory, 'state', 'mounts.json'), [{ input: legacyInput, mayBeMounted: false,
    view: { id: crypto.randomUUID(), name: 'Legacy mount', mountPoint: legacyInput.mountPoint, source: legacyInput.source, state: 'stopped' } }]);
  const manager = await createMountManager({ directory: join(directory, 'state'), binary: 'unused', localConnection,
    control: fake.control, checkDependencies: async () => {} });
  cleanup.push(async () => { fake.setBusy(false); await manager.close(); });
  expect((await manager.list())[0]?.directoryCacheSeconds).toBe(31536000); expect(fake.calls).toHaveLength(0);
  expect((await manager.list())[0]?.autoMount).toBe(true);
  const mounted = await manager.mount(legacyInput);
  expect(mounted.directoryCacheSeconds).toBe(31536000);
  expect(fake.calls.find(call => call.method === 'mount/mount')?.parameters.vfsOpt).toMatchObject({ DirCacheTime: '31536000s', CacheMode: 'full', CacheMaxSize: 8192 * 1024 * 1024, CacheMaxAge: '8760h', ReadAhead: 0 });
  expect(fake.calls.find(call => call.method === 'mount/mount')?.parameters).toMatchObject({
    _config: { BufferSize: 128 * 1024 }, vfsOpt: { ChunkSize: 1024 * 1024, ChunkSizeLimit: -1, ChunkStreams: 0 }
  });
  const updated = await manager.configureCache(mounted.id, { directoryCacheSeconds: 0 });
  expect(updated).toMatchObject({ id: mounted.id, directoryCacheSeconds: 0, state: 'mounted' });
  expect(fake.calls.filter(call => call.method === 'mount/mount').at(-1)?.parameters.vfsOpt).toMatchObject({ DirCacheTime: 'off', CacheMode: 'full' });
  expect(await manager.configureAutoMount(mounted.id, false)).toMatchObject({ autoMount: false, state: 'mounted' });
  expect(fake.mountCalls()).toBe(2);
  fake.setBusy(true);
  await expect(manager.configureCache(mounted.id, { directoryCacheSeconds: 900 })).rejects.toMatchObject({ code: 'mount_busy' });
  expect((await manager.list())[0]?.directoryCacheSeconds).toBe(0);
  const persisted = JSON.parse(await readFile(join(directory, 'state', 'mounts.json'), 'utf8'));
  expect(persisted[0].input.directoryCacheSeconds).toBe(0); expect(fake.mountCalls()).toBe(2);
  fake.setBusy(false); await manager.unmount(mounted.id);
  expect((await manager.list())[0]?.autoMount).toBe(false);
  expect(await manager.configureCache(mounted.id, { directoryCacheSeconds: 1200, fileCacheMaxMiB: 64, fileCacheMaxAgeHours: 0 }))
    .toMatchObject({ state: 'stopped', directoryCacheSeconds: 1200, fileCacheMaxMiB: 64, fileCacheMaxAgeHours: 0 });
  expect(fake.mountCalls()).toBe(2);
  expect(await manager.remount(mounted.id)).toMatchObject({ state: 'mounted', directoryCacheSeconds: 1200 });
  expect((await manager.list())[0]?.autoMount).toBe(false);
  expect(fake.calls.filter(call => call.method === 'mount/mount').at(-1)?.parameters.vfsOpt).toMatchObject({ DirCacheTime: '1200s', CacheMaxSize: 64 * 1024 * 1024, CacheMaxAge: 'off' });
  expect(await manager.configureCache(mounted.id, { directoryCacheSeconds: 1200, fileCacheMaxMiB: 0 })).toMatchObject({ fileCacheMaxMiB: 0, fileCacheMaxAgeHours: 0 });
  expect(fake.calls.filter(call => call.method === 'mount/mount').at(-1)?.parameters.vfsOpt).toMatchObject({ CacheMode: 'off' });
  await manager.configureAutoMount(mounted.id, true);
  await manager.unmount(mounted.id);
  expect((await manager.list())[0]).toMatchObject({ state: 'stopped', autoMount: true });
  expect(JSON.parse(await readFile(join(directory, 'state', 'mounts.json'), 'utf8'))[0]).toMatchObject({ input: { autoMount: true }, view: { autoMount: true } });
});

test('mount directory refresh forgets only its VFS and local publishing does not start inactive rclone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-mount-forget-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const fake = fakeControl();
  const manager = await createMountManager({ directory: join(directory, 'state'), binary: 'unused', localConnection,
    control: fake.control, checkDependencies: async () => {} });
  cleanup.push(() => manager.close());
  await manager.refreshLocal(); expect(fake.calls).toHaveLength(0);
  const local = await manager.mount({ mountPoint: join(directory, 'local'), source: { kind: 'local' } });
  const remote = await manager.mount({ mountPoint: join(directory, 'remote'), source: { kind: 'remote', url: 'http://example.com/dav/', username: 'reader', password: 'secret' } });
  await manager.refreshLocal();
  expect(fake.calls.filter(call => call.method === 'vfs/forget').map(call => call.parameters)).toEqual([{ fs: `musicfs_${local.id.replaceAll('-', '')}:` }]);
  await manager.refreshLocal(['/实例/喜欢的音乐', '/另一入口/歌单']);
  expect(fake.calls.filter(call => call.method === 'vfs/forget').slice(-2).map(call => call.parameters)).toEqual([
    { fs: `musicfs_${local.id.replaceAll('-', '')}:`, dir: '实例/喜欢的音乐' },
    { fs: `musicfs_${local.id.replaceAll('-', '')}:`, dir: '另一入口/歌单' }
  ]);
  const unchanged = fake.calls.length; await manager.refreshLocal([]); expect(fake.calls).toHaveLength(unchanged);
  await manager.refresh(remote.id);
  expect(fake.calls.filter(call => call.method === 'vfs/forget').at(-1)?.parameters).toEqual({ fs: `musicfs_${remote.id.replaceAll('-', '')}:` });
  expect(fake.mountCalls()).toBe(2);
  await manager.unmount(local.id);
  const before = fake.calls.length; await manager.refreshLocal(); expect(fake.calls).toHaveLength(before);
  await expect(manager.refresh(local.id)).rejects.toMatchObject({ code: 'invalid_mount' });
});

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
  const restarted = await recovered.remount(local.id);
  expect(restarted).toMatchObject({ id: local.id, name: local.name, state: 'mounted' });
  expect([...fake.remotes.values()].find(remote => remote.url === localUrl)?.pass).toBe('local-secret');
  expect((await recovered.list()).find(item => item.id === local.id)?.state).toBe('mounted');
});

test('saved remote mounts reconnect with the same identity and private credentials, then can be removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-remount-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const fake = fakeControl();
  const options = { directory: join(directory, 'state'), binary: 'unused', localConnection,
    control: fake.control, checkDependencies: async () => {} };
  const manager = await createMountManager(options);
  cleanup.push(() => manager.close());
  const input = { name: 'My remote', mountPoint: join(directory, 'music'), source: {
    kind: 'remote' as const, url: 'https://example.com/dav/', username: 'saved-user', password: 'saved-password'
  } };
  const first = await manager.mount(input);
  await manager.unmount(first.id);
  expect(fake.remotes.size).toBe(0);
  const recovered = await createMountManager(options);
  const restarted = await recovered.remount(first.id);
  expect(restarted).toMatchObject({ id: first.id, name: 'My remote', mountPoint: input.mountPoint, state: 'mounted' });
  expect([...fake.remotes.values()]).toEqual([{ url: input.source.url, vendor: 'rclone', user: 'saved-user', pass: 'saved-password' }]);
  expect(JSON.stringify(restarted)).not.toContain('saved-user'); expect(JSON.stringify(restarted)).not.toContain('saved-password');
  await recovered.remove(first.id);
  expect(fake.remotes.size).toBe(0); expect(await recovered.list()).toEqual([]);
  expect(await readFile(join(options.directory, 'mounts.json'), 'utf8')).toBe('[]');
  expect((await stat(input.mountPoint)).isDirectory()).toBe(true);
  expect(await (await createMountManager(options)).list()).toEqual([]);
  await expect(recovered.remount(first.id)).rejects.toMatchObject({ code: 'not_found' });
  await expect(recovered.remove(first.id)).rejects.toMatchObject({ code: 'not_found' });
});

test('stopped and failed definitions can be removed along with leftover remote configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-remove-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const fake = fakeControl();
  const options = { directory: join(directory, 'state'), binary: 'unused', localConnection,
    control: fake.control, checkDependencies: async () => {} };
  const manager = await createMountManager(options);
  cleanup.push(() => manager.close());
  const stopped = await manager.mount({ mountPoint: join(directory, 'stopped'), source: { kind: 'local' } });
  await manager.unmount(stopped.id);
  await manager.remove(stopped.id);
  fake.setListFailure(true);
  const failed = await manager.mount({ mountPoint: join(directory, 'failed'), source: { kind: 'local' } });
  expect(failed.state).toBe('error'); expect(fake.remotes.size).toBe(1);
  fake.setListFailure(false);
  const retried = await manager.remount(failed.id);
  expect(retried).toMatchObject({ id: failed.id, state: 'mounted' });
  await manager.unmount(failed.id);
  fake.setListFailure(true);
  const failedAgain = await manager.remount(failed.id);
  expect(failedAgain.state).toBe('error'); expect(fake.remotes.size).toBe(1);
  await manager.remove(failed.id);
  expect(fake.remotes.size).toBe(0); expect(await manager.list()).toEqual([]);
  expect(await readFile(join(options.directory, 'mounts.json'), 'utf8')).toBe('[]');
});

test('dependency failures can be removed without starting rclone or requiring its binary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-remove-dependency-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const manager = await createMountManager({ directory, binary: join(directory, 'missing-rclone'), localConnection,
    checkDependencies: async () => { throw new MountError('dependency_missing', 'WinFsp is not installed'); } });
  cleanup.push(() => manager.close());
  const failed = await manager.mount({ mountPoint: join(directory, 'music'), source: { kind: 'local' } });
  expect(failed).toMatchObject({ state: 'error', error: { code: 'dependency_missing' } });
  await manager.remove(failed.id);
  expect(await manager.list()).toEqual([]);
  expect(await readFile(join(directory, 'mounts.json'), 'utf8')).toBe('[]');
  expect(await Bun.file(join(directory, 'rclone-runtime.json')).exists()).toBe(false);
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
  await expect(manager.remount(mounted.id)).rejects.toMatchObject({ code: 'mount_busy' });
  await expect(manager.remove(mounted.id)).rejects.toMatchObject({ code: 'mount_busy' });
  await expect(manager.close()).rejects.toMatchObject({ code: 'mount_busy' });
  expect(fake.mountCalls()).toBe(1); expect(fake.remotes.size).toBe(1);
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

test('Windows mount requests keep drive letters and normalize Windows directory paths before calling cmount', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-windows-mounts-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const fake = fakeControl();
  const requests: Record<string, unknown>[] = [];
  const control: RcloneControl = {
    async call<T>(method: string, parameters: Record<string, unknown> = {}) {
      if (method === 'mount/mount') {
        requests.push(parameters);
        throw new MountError('mount_failed', 'Stop before the platform filesystem in this contract test');
      }
      return fake.control.call<T>(method, parameters);
    },
    removeRemote: name => fake.control.removeRemote(name),
    close: () => fake.control.close()
  };
  const manager = await createMountManager({ directory: join(directory, 'state'), binary: 'unused', localConnection,
    control, platform: 'win32', checkDependencies: async () => {} });
  cleanup.push(() => manager.close());
  for (const mountPoint of ['M:', '*', 'C:\\MusicFS\\temporary\\..\\mount']) {
    await manager.mount({ mountPoint, source: { kind: 'local' } });
  }
  expect(requests.map(request => ({ mountPoint: request.mountPoint, mountType: request.mountType }))).toEqual([
    { mountPoint: 'M:', mountType: 'cmount' },
    { mountPoint: '*', mountType: 'cmount' },
    { mountPoint: 'C:\\MusicFS\\mount', mountType: 'cmount' }
  ]);
  await manager.mount({ name: '这是超过原生卷标长度的中文音乐目录', mountPoint: 'N:', source: { kind: 'local' } });
  expect(requests.at(-1)?.mountOpt).toMatchObject({ VolumeName: '这是超过原生卷标长度' });
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
  await second.removeRemote('endpoint_contract');
  await second.close();
  expect(await Bun.file(join(directory, 'rclone-runtime.json')).exists()).toBe(false);
});
