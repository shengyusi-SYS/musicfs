import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMountRestore } from '../src/hosts/desktop/mount-restore';
import { createMountManager, MountError } from '../src/hosts/desktop/mounts';
import { writePrivateJson, type RcloneControl } from '../src/hosts/desktop/rclone-control';
import type { MountView } from '../src/contracts/mounts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('startup restoration retries offline mounts without blocking list; manual unmount owns the current session only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-mount-restore-'));
  const entered = deferred(); const release = deferred();
  const id = crypto.randomUUID(); const excluded = crypto.randomUUID();
  const point = join(directory, 'music');
  await writePrivateJson(join(directory, 'mounts.json'), [
    { input: { mountPoint: point, source: { kind: 'local' } },
      view: { id, name: 'My music', mountPoint: point, source: { kind: 'local' }, state: 'stopped' } },
    { input: { mountPoint: join(directory, 'manual'), source: { kind: 'local' }, autoMount: false },
      view: { id: excluded, name: 'Manual', mountPoint: join(directory, 'manual'), source: { kind: 'local' }, autoMount: false, state: 'stopped' } }
  ]);
  const mounted = new Map<string, string>();
  let attempts = 0; let nativeMounts = 0;
  const control: RcloneControl = {
    async call<T>(method: string, parameters: Record<string, unknown> = {}) {
      let value: unknown = {};
      if (method === 'operations/list') {
        attempts++;
        if (attempts === 1) throw new MountError('mount_failed', 'Network is not ready');
        entered.resolve(); await release.promise;
      }
      if (method === 'mount/types') value = { mountTypes: ['mount'] };
      if (method === 'mount/listmounts') value = { mountPoints: [...mounted].map(([MountPoint, Fs]) => ({ MountPoint, Fs })) };
      if (method === 'mount/mount') {
        nativeMounts++; mounted.set(String(parameters.mountPoint), String(parameters.fs));
        value = { mountPoint: parameters.mountPoint };
      }
      if (method === 'mount/unmount') mounted.delete(String(parameters.mountPoint));
      if (method === 'config/get') value = { url: 'http://127.0.0.1:12345/dav/' };
      return value as T;
    },
    async removeRemote() {}, async close() {}
  };
  const manager = await createMountManager({ directory, binary: 'unused', control, platform: 'linux',
    localConnection: () => ({ url: 'http://127.0.0.1:12345/dav/', username: 'musicfs', password: 'local-secret' }),
    checkDependencies: async () => {} });
  const restore = createMountRestore({ mounts: manager, settings: { enabled: false, retry: true }, retryDelaysMs: [1] });
  try {
    restore.start();
    expect(attempts).toBe(0);
    restore.configure({ enabled: true, retry: true });
    await entered.promise;
    const views = await Promise.race([manager.list(), Bun.sleep(100).then(() => { throw new Error('Mount list blocked behind startup IO'); })]);
    expect(views.find(mount => mount.id === id)).toMatchObject({ state: 'starting', autoMount: true });
    expect(views.find(mount => mount.id === excluded)).toMatchObject({ state: 'stopped', autoMount: false });
    restore.cancel(id);
    const stopped = manager.unmount(id);
    release.resolve();
    expect(await stopped).toMatchObject({ state: 'stopped', autoMount: true });
    await restore.close();
    expect(attempts).toBe(2); expect(nativeMounts).toBe(1);
    const saved = JSON.parse(await Bun.file(join(directory, 'mounts.json')).text());
    expect(saved.find((record: { view: { id: string } }) => record.view.id === id)).toMatchObject({ input: { autoMount: true }, view: { autoMount: true, state: 'stopped' } });
  } finally { release.resolve(); await restore.close(); await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a refused quit can resume pending startup retries', async () => {
  const first = deferred(); const retried = deferred(); let attempts = 0;
  const mount: MountView = { id: 'fixture', name: 'Music', mountPoint: '/fixture', source: { kind: 'local' }, autoMount: true,
    directoryCacheSeconds: 300, fileCacheMaxMiB: 8192, fileCacheMaxAgeHours: 168, state: 'stopped' };
  const restore = createMountRestore({ retryDelaysMs: [10], mounts: { list: async () => [mount], remount: async () => {
    attempts++; if (attempts === 1) first.resolve(); else retried.resolve();
    return { ...mount, state: attempts === 1 ? 'error' : 'mounted', ...(attempts === 1 ? { error: { code: 'mount_failed', message: 'offline' } } : {}) };
  } } });
  try {
    restore.start(); await first.promise;
    const resume = await restore.pause();
    restore.configure({ enabled: true, retry: true });
    expect(attempts).toBe(1);
    resume();
    await Promise.race([retried.promise, Bun.sleep(200).then(() => { throw new Error('Startup retry did not resume'); })]);
    expect(attempts).toBe(2);
  } finally { await restore.close(); }
});
