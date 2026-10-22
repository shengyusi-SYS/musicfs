import { beforeAll, expect, test } from 'bun:test';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopService } from '../src/hosts/desktop/service';
import { buildSample } from '../scripts/build-sample';

let archive: Uint8Array;
beforeAll(async () => { archive = await buildSample(); });

for (const route of ['mount', 'public'] as const) {
  test(`${route} DAV wakes cold directory work without a management page`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'musicfs-dav-background-'));
    const unused = async (): Promise<never> => { throw new Error('Directory listing must not activate native audio caching'); };
    const credentials = { username: 'reader', password: 'fixture-password' };
    const service = await createDesktopService({ directory, adminToken: 'fixture-admin', dav: credentials,
      readCache: { controlDirectory: join(directory, 'control'), control: { call: unused, removeRemote: unused, close: async () => {} } } });
    const admin = { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' };
    try {
      const installed = await service.app.request('/api/plugins', { method: 'POST', headers: { Authorization: admin.Authorization }, body: new Uint8Array(archive) });
      expect(installed.status).toBe(201);
      const created = await service.app.request('/api/instances', { method: 'POST', headers: admin,
        body: JSON.stringify({ pluginId: 'org.musicfs.sample', name: 'Cold', config: { label: 'Music' } }) });
      expect(created.status).toBe(201);
      const id = (await created.json() as { value: { id: string } }).value.id;
      // Let the startup wake finish with an empty queue before the mount creates work.
      await yieldToIo();
      expect(service.store.currentRefresh(id)).toBeNull();
      const connection = route === 'mount' ? service.readCache!.mountConnection : { url: 'http://fixture/dav/', ...credentials };
      const request = () => {
        const url = connection.url + 'Cold/Music/';
        const init = { method: 'PROPFIND', headers: { Depth: '1', Authorization: 'Basic ' + btoa(`${connection.username}:${connection.password}`) } };
        return route === 'mount' ? fetch(url, init) : service.app.request(url, init);
      };
      // First the source roots, then the requested directory. Neither uses /api/refreshes/*.
      for (const key of [{ kind: 'roots' as const, ref: '' }, { kind: 'directory' as const, ref: '/' }]) {
        const response = await request();
        expect(response.status).toBe(503);
        const operationId = response.headers.get('X-MusicFS-Refresh');
        expect(operationId).toBeString(); await response.body?.cancel();
        const deadline = Date.now() + 750;
        while (service.store.refreshRecord(operationId!)?.status !== 'completed' && Date.now() < deadline) await Bun.sleep(10);
        expect(service.store.refreshRecord(operationId!)?.status).toBe('completed');
        expect(service.store.snapshot(id, key)?.value).toBeDefined();
      }
      const ready = await request();
      expect(ready.status).toBe(207); expect(await ready.text()).toContain('440 Hz.wav');
    } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
