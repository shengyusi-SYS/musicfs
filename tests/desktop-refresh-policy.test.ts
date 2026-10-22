import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MountManager } from '../src/contracts/mounts';
import { createDesktopService } from '../src/hosts/desktop/service';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import { requestReady } from '../scripts/helpers/refresh-http';

test('desktop schedules progress without a page and retain mount listings when published entries are unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-policy-desktop-'));
  let service: Awaited<ReturnType<typeof createDesktopService>> | undefined;
  let instanceId = ''; const publications: string[] = [];
  const unused = async (): Promise<never> => { throw new Error('Mount lifecycle is outside this publication probe'); };
  const mounts: MountManager = { list: async () => [], mount: unused, remount: unused, unmount: unused, remove: unused,
    rename: unused, configureAutoMount: unused, configureCache: unused, cacheStatus: unused, clearCache: unused, refresh: unused, close: async () => {},
    async refreshLocal() {
      const published = service?.store.snapshot(instanceId, { kind: 'directory', ref: '/' })?.value;
      if (published) publications.push(published.id);
    } };
  const options = { directory, adminToken: 'fixture-admin', dav: { username: 'reader', password: 'fixture' }, mounts };
  const request = async (path: string, init: RequestInit = {}) => service!.app.request(path, { ...init,
    headers: { Authorization: 'Bearer fixture-admin', ...init.headers } });
  try {
    service = await createDesktopService(options);
    const install = await request('/api/plugins', { method: 'POST', body: await Bun.file('dist/plugins/org.musicfs.sample.zip').arrayBuffer() });
    expect(install.status).toBe(201);
    const created = await request('/api/instances', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginId: 'org.musicfs.sample', name: '定时目录', config: { label: '音乐' } }) });
    instanceId = (await created.json() as { value: { id: string } }).value.id;
    const listed = await requestReady(request, '/api/library?path=' + encodeURIComponent('/定时目录/音乐'), {}, { Authorization: 'Bearer fixture-admin' });
    expect(listed.status).toBe(200);
    const previous = service.store.snapshot(instanceId, { kind: 'directory', ref: '/' })?.value;
    expect(previous).toBeTruthy();
    const configured = await request(`/api/instances/${instanceId}/refresh-policy?directoryRef=%2F`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intervalMinutes: 15 }) });
    expect(configured.status).toBe(200);
    await service.close(); service = undefined;
    const clock = openSqlite(join(directory, 'state.sqlite'));
    await clock.saveRefreshSchedule(instanceId, { kind: 'directory', ref: '/' }, 15, Date.now() - 1);
    clock.close(); publications.length = 0;
    service = await createDesktopService(options);
    const deadline = Date.now() + 2_000;
    while (service.store.snapshot(instanceId, { kind: 'directory', ref: '/' })?.value?.id === previous!.id && Date.now() < deadline) await Bun.sleep(5);
    const current = service.store.snapshot(instanceId, { kind: 'directory', ref: '/' })?.value;
    expect(current?.id).not.toBe(previous!.id);
    expect(publications).toEqual([]);
    expect(service.store.currentRefresh(instanceId)?.status).toBe('completed');
    expect(service.store.nextRefreshScheduleAt()).toBeGreaterThan(Date.now());
    // A changed durable schedule must wake the resident runner without another HTTP response.
    publications.length = 0;
    service.store.saveRefreshSchedule(instanceId, { kind: 'directory', ref: '/' }, 15, Date.now() - 1);
    const nextDeadline = Date.now() + 750;
    while (service.store.snapshot(instanceId, { kind: 'directory', ref: '/' })?.value?.id === current!.id && Date.now() < nextDeadline) await Bun.sleep(5);
    expect(service.store.snapshot(instanceId, { kind: 'directory', ref: '/' })?.value?.id).not.toBe(current!.id);
    expect(publications).toEqual([]);
  } finally { await service?.close(); await rm(directory, { recursive: true, force: true }); }
});
