import { expect, test } from 'bun:test';
import { getLogger } from '@logtape/logtape';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { configureDesktopLogging } from '../src/hosts/desktop/logging';
import { createDesktopService } from '../src/hosts/desktop/service';
import { createRcloneControl } from '../src/hosts/desktop/rclone-control';
import { createApi } from '../src/web/api';

test('desktop diagnostics change the live logger, persist settings and download only diagnostic files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-diagnostics-'));
  let logging = await configureDesktopLogging(directory);
  const control = createRcloneControl({ directory: join(directory, 'mounts'), binary: join(directory, 'not-installed-rclone') });
  logging.attachNative(level => control.configureLogging!(level));
  const service = await createDesktopService({ directory, logging, adminToken: 'fixture-admin', dav: { username: 'reader', password: 'fixture-password' } });
  const app = service.app;
  const api = createApi('fixture-admin', ((input, init) => app.request(String(input), init)) as typeof fetch);
  try {
    expect((await app.request('/api/desktop/diagnostics')).status).toBe(401);
    expect((await app.request('/api/desktop/diagnostics/download')).status).toBe(401);
    const signedIn = await app.request('/api/access/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'fixture-admin' }) });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    expect((await app.request('/api/desktop/diagnostics', { headers: { Cookie: cookie } })).status).toBe(200);
    const initial = await api.diagnostics();
    expect(initial.settings).toEqual({ level: 'info', nativeLevel: 'ERROR' });
    await api.saveDiagnostics({ level: 'debug', nativeLevel: 'DEBUG' });
    expect((await api.diagnostics()).startedAt).toBe(initial.startedAt);
    getLogger(['musicfs', 'io', 'source']).debug('Fixture debug after live change');
    expect(await Bun.file(join(directory, 'logs/musicfs.log')).text()).toContain('Fixture debug after live change');
    expect(await Bun.file(join(directory, 'mounts/rclone-runtime.json')).exists()).toBe(false);
    await mkdir(join(directory, 'mounts'), { recursive: true });
    await Bun.write(join(directory, 'mounts/rclone.log'), 'fixture-native-log\n');
    await Bun.write(join(directory, 'credentials.json'), '{"password":"fixture-not-exported"}');
    const blob = await api.downloadDiagnostics();
    const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(archive).sort()).toEqual(['application/musicfs.log', 'diagnostics.json', 'native/rclone.log']);
    expect(strFromU8(archive['native/rclone.log']!)).toContain('fixture-native-log');
    expect(JSON.parse(strFromU8(archive['diagnostics.json']!))).toMatchObject({ settings: { level: 'debug', nativeLevel: 'DEBUG' }, startedAt: initial.startedAt });
    expect(JSON.stringify(Object.values(archive).map(value => strFromU8(value)))).not.toContain('fixture-not-exported');
    logging.close(); logging = await configureDesktopLogging(directory);
    expect(logging.inspect().settings).toEqual({ level: 'debug', nativeLevel: 'DEBUG' });
  } finally { await service.close(); logging.close(); await control.close(); await rm(directory, { recursive: true, force: true }); }
});
