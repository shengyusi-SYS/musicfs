import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopService } from '../src/hosts/desktop/service';
import { createApi } from '../src/web/api';
import { davImportUrl } from '../src/web/dav-link';

test('player credentials change immediately, persist across desktop restarts and leave management access independent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-dav-access-'));
  const defaults = { username: 'musicfs', password: 'initial-player-password' };
  const changed = { username: '音乐 @+?', password: 'pass: @/#?%+密 码' };
  const basic = (value: typeof defaults) => ({ Authorization: 'Basic ' + Buffer.from(`${value.username}:${value.password}`).toString('base64') });
  let service = await createDesktopService({ directory, adminToken: 'fixture-admin', dav: defaults });
  const api = createApi('fixture-admin', ((path, init) => service.app.request(String(path), init)) as typeof fetch);
  const connection = () => api.connection(new AbortController().signal);
  const allowed = (value: typeof defaults) => service.app.request('/dav/', { method: 'OPTIONS', headers: basic(value) });
  try {
    expect(await connection()).toEqual({ davPath: '/dav', ...defaults });
    expect((await allowed(defaults)).status).toBe(200);
    expect(await api.saveConnection(changed)).toEqual({ davPath: '/dav', ...changed });
    expect(await connection()).toEqual({ davPath: '/dav', ...changed });
    expect((await allowed(defaults)).status).toBe(401);
    expect((await allowed(changed)).status).toBe(200);
    expect((await service.app.request('/api/connection', { method: 'PUT', headers: { ...basic(changed), 'Content-Type': 'application/json' }, body: JSON.stringify(defaults) })).status).toBe(401);
    await expect(api.saveConnection({ username: 'unsupported:name', password: 'x' })).rejects.toMatchObject({ status: 422 });
    expect((await allowed(changed)).status).toBe(200);
    await service.close();
    service = await createDesktopService({ directory, adminToken: 'fixture-admin', dav: defaults });
    expect(await connection()).toEqual({ davPath: '/dav', ...changed });
    expect((await allowed(changed)).status).toBe(200);
    expect((await allowed(defaults)).status).toBe(401);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the generic QR connection URL preserves special characters, HTTPS ports and the DAV path', () => {
  const credentials = { username: '音乐 @+?', password: 'pass: @/#?%+密 码' };
  const url = new URL(davImportUrl('https://music.example:9443/dav/', credentials));
  expect(decodeURIComponent(url.username)).toBe(credentials.username);
  expect(decodeURIComponent(url.password)).toBe(credentials.password);
  expect(url.origin + url.pathname).toBe('https://music.example:9443/dav/');
  expect(url.hash).toBe(''); expect(url.search).toBe('');
});
