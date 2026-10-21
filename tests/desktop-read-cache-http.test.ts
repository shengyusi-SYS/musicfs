import { expect, test } from 'bun:test';
import type { ReadCacheManager, ReadCacheStatus } from '../src/contracts/read-cache';
import { createDesktopHttp } from '../src/hosts/desktop/http';
import { MountError } from '../src/hosts/desktop/rclone-control';
import { createApi } from '../src/web/api';

const unused = async (): Promise<never> => { throw new Error('Unrelated desktop capability was called'); };
const initial: ReadCacheStatus = {
  settings: { maxMiB: 16384, maxAgeHours: 168 }, actualMode: 'full', state: 'active',
  directory: '/fixture/shared-cache', bytesUsed: 32768, files: 1,
  sampledAt: '2026-10-21T00:00:00.000Z', message: null
};

function fixture(readCache?: ReadCacheManager, prepareQuit?: () => Promise<void | (() => void)>) {
  const app = createDesktopHttp({ directory: '/unused', adminToken: 'fixture-admin', network: { access: 'local', port: 0 }, port: () => 8787,
    mounts: { list: unused, mount: unused, remount: unused, unmount: unused, remove: unused, rename: unused, configureAutoMount: unused, configureCache: unused,
      cacheStatus: unused, clearCache: unused, refresh: unused, refreshLocal: unused, close: unused },
    prerequisites: { inspect: unused, installWinFsp: unused, check: unused },
    https: { inspect: unused, enable: unused, trust: unused, restoreFileSizeLimit: unused, disable: unused, close: unused },
    ...(readCache ? { readCache } : {}), ...(prepareQuit ? { prepareQuit } : {}), close: unused });
  const fetcher = ((path: string | URL | Request, init?: RequestInit) => app.request(String(path), init)) as typeof fetch;
  return { app, api: createApi('fixture-admin', fetcher) };
}

test('desktop shared cache management passes status and settings through the browser API independently of mounts', async () => {
  let status = structuredClone(initial); const calls: string[] = [];
  const { api } = fixture({
    async inspect() { calls.push('inspect'); return status; },
    async configure(settings) { calls.push('configure'); status = { ...status, settings }; return status; },
    async clear() { calls.push('clear'); status = { ...status, bytesUsed: 0, files: 0 }; return status; }
  });
  expect(await api.desktopReadCache(new AbortController().signal)).toEqual(initial);
  expect(await api.configureDesktopReadCache({ maxMiB: 0, maxAgeHours: 0 })).toMatchObject({ settings: { maxMiB: 0, maxAgeHours: 0 } });
  expect(await api.clearDesktopReadCache()).toMatchObject({ bytesUsed: 0, files: 0 });
  expect(calls).toEqual(['inspect', 'configure', 'clear']);
});

test('shared cache route requires desktop auth and does not exist without the desktop capability', async () => {
  const { app, api } = fixture();
  expect((await app.request('/api/desktop/read-cache')).status).toBe(401);
  for (const call of [() => api.desktopReadCache(new AbortController().signal),
    () => api.configureDesktopReadCache({ maxMiB: 16, maxAgeHours: 24 }), () => api.clearDesktopReadCache()]) {
    await expect(call()).rejects.toMatchObject({ status: 404 });
  }
});

test('invalid settings never reach the cache manager and active-read errors retain their actionable message', async () => {
  let configurations = 0;
  const { app, api } = fixture({ inspect: async () => initial,
    async configure() { configurations++; throw new MountError('mount_busy', '当前有活动读取，请稍后重试。'); },
    async clear() { throw new MountError('mount_busy', '当前有活动读取，请稍后重试。'); }
  });
  const rejected = await app.request('/api/desktop/read-cache', { method: 'PUT',
    headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxMiB: -1, maxAgeHours: 168 }) });
  expect(rejected.status).toBe(422); expect(configurations).toBe(0);
  await expect(api.configureDesktopReadCache({ maxMiB: 16384, maxAgeHours: 168 })).rejects.toMatchObject({ status: 422,
    message: '当前有活动读取，请稍后重试。', code: 'mount_busy' });
  await expect(api.clearDesktopReadCache()).rejects.toMatchObject({ status: 422, code: 'mount_busy' });
  expect(configurations).toBe(1);
});


test('active shared reads prevent quitting before unrelated mounts are touched', async () => {
  const { app } = fixture(undefined, async () => { throw new MountError('mount_busy', '仍有 WebDAV 音频正在读取'); });
  const response = await app.request('/api/desktop/quit', { method: 'POST', headers: { Authorization: 'Bearer fixture-admin' } });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: 'mount_busy', message: '仍有 WebDAV 音频正在读取' });
});


test('failed normal unmount restores read admission after quit preparation', async () => {
  let resumed = 0;
  const { app } = fixture(undefined, async () => () => { resumed++; });
  const response = await app.request('/api/desktop/quit', { method: 'POST', headers: { Authorization: 'Bearer fixture-admin' } });
  expect(response.status).toBe(409); expect(resumed).toBe(1);
});
