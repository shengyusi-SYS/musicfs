import assert from 'node:assert/strict';
import { access, mkdtemp, rm, mkdir, open, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { requestReady } from '../helpers/refresh-http';
import type { ContentSources, DirectoryListing, PluginInspection, Result, SourceInstance } from '../../src/contracts/management';

// Runs a generated native release, rather than src/desktop.ts or the dev service.
const { values } = parseArgs({ args: Bun.argv.slice(2), options: { directory: { type: 'string' }, 'keep-running': { type: 'boolean' }, mount: { type: 'boolean' }, 'crash-recovery': { type: 'boolean' },
  'plugin-archive': { type: 'string' }, 'plugin-id': { type: 'string' } } });
assert(!values['crash-recovery'] || values.mount, '--crash-recovery requires --mount');
assert.equal(values['plugin-archive'] !== undefined, values['plugin-id'] !== undefined, 'Provide --plugin-archive and --plugin-id together');
const authorPlugin = values['plugin-archive'] !== undefined;
if (authorPlugin) assert(values['plugin-archive']!.trim() && values['plugin-id']!.trim(), 'Provide a nonempty plugin archive path and plugin ID');
const release = resolve(values.directory ?? 'dist/desktop/linux-x64');
const pluginArchive = resolve(values['plugin-archive'] ?? join(release, 'plugins/org.musicfs.sample.zip'));
const pluginId = values['plugin-id'] ?? 'org.musicfs.sample';
const metadata = await Bun.file(join(release, 'release.json')).json() as { target: string; executable: string; version: string };
const native = `${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`;
assert.equal(metadata.target, native, 'Run each release probe on its native target system');
const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-product-'));
const executable = join(release, metadata.executable);
let origin = ''; let token = ''; let keptForBrowser = false;
const launch = async () => {
  const child = Bun.spawn([executable, '--no-open', '--no-integration', '--data', directory], { stdout: 'pipe', stderr: 'pipe' });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  assert.equal(code, 0, error);
  return child.pid;
};
try {
  const frontPid = await launch();
  let runtime = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')) as { pid: number; origin: string };
  const credentials = JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8')) as { adminToken: string; username: string; password: string };
  origin = runtime.origin; token = credentials.adminToken;
  assert.notEqual(frontPid, runtime.pid);
  const admin = { Authorization: `Bearer ${token}` };
  const json = { ...admin, 'Content-Type': 'application/json' };
  const page = await fetch(origin); assert.equal(page.status, 200); assert((await page.text()).includes('<div id="root">'));
  const status = await fetch(origin + '/api/status', { headers: admin }); assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { host: 'desktop', version: metadata.version });
  const ticketResponse = await fetch(origin + '/api/access/ticket', { method: 'POST', headers: admin });
  assert.equal(ticketResponse.status, 200);
  const ticket = await ticketResponse.json() as { ticket: string };
  const exchanged = await fetch(origin + '/api/access/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ticket) });
  assert.equal(exchanged.status, 200); await exchanged.body?.cancel();
  const cookie = exchanged.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); assert(cookie);
  const preferences = await fetch(origin + '/api/desktop/preferences', { headers: { Cookie: cookie } });
  assert.equal(preferences.status, 200);
  assert.deepEqual((await preferences.json() as { settings: unknown }).settings,
    { launchAtLogin: true, openOnLaunch: true, openOnLogin: false, autoMount: true, retryAutoMount: true });
  const logout = await fetch(origin + '/api/access/logout', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(logout.status, 200); await logout.body?.cancel();
  const expired = await fetch(origin + '/api/desktop/preferences', { headers: { Cookie: cookie } });
  assert.equal(expired.status, 401); await expired.body?.cancel();
  const initial = await fetch(origin + '/api/plugins', { headers: admin }); assert.deepEqual(await initial.json(), []);
  const inspection = await fetch(origin + '/api/plugins/inspect', { method: 'POST', headers: admin,
    body: await Bun.file(pluginArchive).arrayBuffer() });
  assert.equal(inspection.status, 200);
  const preview = await inspection.json() as PluginInspection;
  assert.equal(preview.manifest.id, pluginId);
  assert.deepEqual(preview.compatibility, { host: 'desktop', apiVersion: '0.1.9', apiCompatible: true, hostCompatible: true });
  assert.deepEqual(await (await fetch(origin + '/api/plugins', { headers: admin })).json(), []);
  const installed = await fetch(origin + '/api/plugins', { method: 'POST', headers: admin, body: await Bun.file(pluginArchive).arrayBuffer() });
  assert.equal(installed.status, 201); await installed.body?.cancel();
  const created = await fetch(origin + '/api/instances', { method: 'POST', headers: json,
    body: JSON.stringify({ pluginId, name: '发行物测试', config: { label: '已知音频' } }) });
  assert.equal(created.status, 201);
  if (authorPlugin) {
    const first = await created.json() as Result<SourceInstance>; assert(first.ok);
    const secondResponse = await fetch(origin + '/api/instances', { method: 'POST', headers: json,
      body: JSON.stringify({ pluginId, name: '作者第二实例', config: { label: '独立音频' } }) });
    assert.equal(secondResponse.status, 201); const second = await secondResponse.json() as Result<SourceInstance>; assert(second.ok);
    assert.notEqual(first.value.id, second.value.id);
    const roots = async (id: string) => {
      const response = await requestReady((url, init) => fetch(url, init), origin + `/api/instances/${encodeURIComponent(id)}/roots`, { headers: admin });
      assert.equal(response.status, 200); return (await response.json() as ContentSources).map(root => root.name);
    };
    const configure = async (id: string, label: string) => {
      const response = await fetch(origin + `/api/instances/${encodeURIComponent(id)}/config`, { method: 'PUT', headers: json, body: JSON.stringify({ config: { label } }) });
      assert.equal(response.status, 200); const result = await response.json() as Result<SourceInstance['config']>; assert(result.ok);
    };
    assert.deepEqual(await roots(first.value.id), ['已知音频']); assert.deepEqual(await roots(second.value.id), ['独立音频']);
    await configure(first.value.id, '仅修改第一实例');
    assert.deepEqual(await roots(first.value.id), ['仅修改第一实例']); assert.deepEqual(await roots(second.value.id), ['独立音频']);
    await configure(first.value.id, '已知音频'); assert.deepEqual(await roots(first.value.id), ['已知音频']);
  } else await created.body?.cancel();
  const file = origin + '/dav/' + ['发行物测试', '已知音频', '440 Hz.wav'].map(encodeURIComponent).join('/');
  const dav = { Authorization: 'Basic ' + btoa(`${credentials.username}:${credentials.password}`) };
  const head = await requestReady((url, init) => fetch(url, init), file, { method: 'HEAD', headers: dav }, admin);
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '16044');
  const range = await fetch(file, { headers: { ...dav, Range: 'bytes=0-3' } }); assert.equal(range.status, 206); assert.equal(await range.text(), 'RIFF');
  const listed = await fetch(origin + '/api/library/directory?path=' + encodeURIComponent('/发行物测试/已知音频'), { headers: admin });
  assert.equal(listed.status, 200);
  const listing = await listed.json() as DirectoryListing;
  assert.deepEqual(listing.entries.map(entry => entry.name), ['440 Hz.wav']);
  assert(listing.status); assert.equal(listing.status.error, null);
  await launch();
  const repeated = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')) as typeof runtime;
  assert.equal(repeated.pid, runtime.pid); assert.equal(repeated.origin, origin);
  assert.equal(JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8')).adminToken, token);
  const mounts = await fetch(origin + '/api/mounts', { headers: admin }); assert.equal(mounts.status, 200); assert.deepEqual(await mounts.json(), []);
  let dependencyFailureTested = false;
  const fusePresent = process.platform === 'linux' && await access('/dev/fuse').then(() => true, () => false);
  if (process.platform === 'linux' && !fusePresent) {
    const mountPoint = join(directory, 'mount-point'); await mkdir(mountPoint);
    const response = await fetch(origin + '/api/mounts', { method: 'POST', headers: json,
      body: JSON.stringify({ mountPoint, source: { kind: 'local' } }) });
    assert.equal(response.status, 201);
    const failed = await response.json() as { id: string; state: string; error?: { code: string } };
    assert.equal(failed.state, 'error'); assert.equal(failed.error?.code, 'dependency_missing');
    const removed = await fetch(origin + '/api/mounts/' + failed.id + '/unmount', { method: 'POST', headers: admin });
    assert.equal(removed.status, 200); assert.equal((await removed.json() as { state: string }).state, 'stopped');
    dependencyFailureTested = true;
  }
  let systemMountTested = false;
  const crashRecoveries: Array<{ portRetained: boolean; recoveryMs: number }> = [];
  if (values.mount) {
    assert.equal(process.platform, 'linux', 'This opt-in fixture mounts a temporary Linux directory');
    const mountPoint = join(directory, 'mount-local'); await mkdir(mountPoint);
    const mounted = await fetch(origin + '/api/mounts', { method: 'POST', headers: json,
      body: JSON.stringify({ mountPoint, source: { kind: 'local' } }) });
    assert.equal(mounted.status, 201); const state = await mounted.json() as { id: string; state: string; error?: unknown };
    assert.equal(state.state, 'mounted', JSON.stringify(state.error));
    const full = new Uint8Array(await (await fetch(file, { headers: dav })).arrayBuffer());
    const path = join(mountPoint, '发行物测试', '已知音频', '440 Hz.wav');
    assert.deepEqual(new Uint8Array(await readFile(path)), full);
    const handle = await open(path, 'r');
    try {
      const width = 1024; const middle = Math.floor((full.length - width) / 2);
      for (const position of [0, middle, full.length - width, middle, 0]) {
        const buffer = Buffer.alloc(width); const read = await handle.read(buffer, 0, width, position);
        assert.equal(read.bytesRead, width); assert.deepEqual(new Uint8Array(buffer), full.slice(position, position + width));
      }
    } finally { await handle.close(); }
    if (values['crash-recovery']) {
      const control = JSON.parse(await readFile(join(directory, 'mounts', 'rclone-runtime.json'), 'utf8')) as { pid: number; port: number; password: string };
      const rc = async <T>(method: string, parameters: Record<string, unknown> = {}) => {
        const response = await fetch(`http://127.0.0.1:${control.port}/${method}`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(`musicfs:${control.password}`) },
          body: JSON.stringify(parameters), signal: AbortSignal.timeout(3_000) });
        assert.equal(response.status, 200); return await response.json() as T;
      };
      const configuredUrl = async () => {
        const active = await rc<{ mountPoints: Array<{ MountPoint: string; Fs: string }> }>('mount/listmounts');
        const point = active.mountPoints.find(item => item.MountPoint === mountPoint); assert(point);
        return (await rc<{ url: string }>('config/get', { name: point.Fs.replace(/:$/, '') })).url;
      };
      for (const occupyPort of [false, true]) {
        const previous = runtime;
        const identity = await fetch(origin + '/__musicfs/identity', { headers: admin });
        assert.equal(identity.status, 200); assert.equal((await identity.json() as { pid: number }).pid, previous.pid);
        process.kill(previous.pid, 'SIGKILL');
        for (let attempt = 0; attempt < 100; attempt++) {
          try { await fetch(origin, { signal: AbortSignal.timeout(200) }); }
          catch { break; }
          assert(attempt < 99, 'The temporary backend must stop before restarting');
          await Bun.sleep(20);
        }
        assert.equal((await rc<{ pid: number }>('core/pid')).pid, control.pid, 'The original rclone must survive the backend crash');
        let blocker: ReturnType<typeof Bun.serve> | undefined;
        try {
          if (occupyPort) blocker = Bun.serve({ hostname: '127.0.0.1', port: Number(new URL(previous.origin).port), fetch: () => new Response(null, { status: 503 }) });
          console.log(JSON.stringify({ recoveryStarted: occupyPort ? 'occupied-port' : 'same-port' }));
          const started = performance.now();
          await launch();
          runtime = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')) as typeof runtime;
          origin = runtime.origin;
          assert.notEqual(runtime.pid, previous.pid);
          assert.equal(origin === previous.origin, !occupyPort);
          assert.deepEqual(JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8')), credentials);
          assert.equal((await rc<{ pid: number }>('core/pid')).pid, control.pid);
          assert.equal(await configuredUrl(), previous.origin + '/dav/');
          const status = await fetch(origin + '/api/mounts', { headers: admin }); assert.equal(status.status, 200);
          const recovered = (await status.json() as Array<{ id: string; state: string; error?: { code: string } }>).find(item => item.id === state.id); assert(recovered);
          if (occupyPort) {
            assert.equal(recovered.state, 'error'); assert.equal(recovered.error?.code, 'remount_required');
            const stopped = await fetch(origin + '/api/mounts/' + state.id + '/unmount', { method: 'POST', headers: admin });
            assert.equal(stopped.status, 200); assert.equal((await stopped.json() as { state: string }).state, 'stopped');
            const remounted = await fetch(origin + '/api/mounts', { method: 'POST', headers: json,
              body: JSON.stringify({ mountPoint, source: { kind: 'local' } }) });
            assert.equal(remounted.status, 201);
            const restored = await remounted.json() as { id: string; state: string; error?: unknown };
            assert.equal(restored.id, state.id); assert.equal(restored.state, 'mounted', JSON.stringify(restored.error));
            assert.equal(await configuredUrl(), origin + '/dav/');
          } else assert.equal(recovered.state, 'mounted');
          assert.deepEqual(new Uint8Array(await readFile(path)), full);
          const result = { portRetained: !occupyPort, recoveryMs: Math.round(performance.now() - started) };
          crashRecoveries.push(result); console.log(JSON.stringify({ recoveryCompleted: result }));
        } finally { await blocker?.stop(true); }
      }
    }
    const held = await open(path, 'r');
    try {
      const busy = await fetch(origin + '/api/mounts/' + state.id + '/unmount', { method: 'POST', headers: admin });
      assert.equal(busy.status, 409); assert.equal((await busy.json() as { error: string }).error, 'mount_busy');
      const alive = await fetch(origin + '/api/status', { headers: admin }); assert.equal(alive.status, 200); await alive.body?.cancel();
    } finally { await held.close(); }
    systemMountTested = true;
  }
  if (values['keep-running']) {
    await Bun.write('/tmp/musicfs-desktop-product-target.json', JSON.stringify({ directory, origin, pid: runtime.pid }));
    keptForBrowser = true;
  }
  console.log(JSON.stringify({ target: native, nativeRelease: true, separateBackground: true, sharedWebUI: true,
    compatibilityInspection: true, externalPluginInstalled: true, directoryListingWithStatus: true, davHead: 16044, exactRange: 'RIFF', repeatedLaunchReused: true,
    ...(authorPlugin ? { authorPluginId: pluginId, independentInstances: 2 } : {}),
    managementCookie: true, desktopPreferences: true, logoutRevoked: true,
    mountsEndpoint: true, dependencyFailureTested, systemMountTested, ...(systemMountTested ? { mountedBytes: 16044, mountedRanges: 5 } : {}),
    ...(values['crash-recovery'] ? { originalRcloneRetained: true, credentialsRetained: true, crashRecoveries } : {}),
    ...(values['keep-running'] ? { origin, keptForBrowserVerification: true } : {}) }));
} finally {
  if (!keptForBrowser) {
    if (origin && token) {
      const response = await fetch(origin + '/api/desktop/quit', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 202); await response.body?.cancel();
      let closed = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { const live = await fetch(origin + '/__musicfs/identity', { signal: AbortSignal.timeout(300) }); await live.body?.cancel(); }
        catch { closed = true; break; }
        await Bun.sleep(50);
      }
      assert(closed, 'The packaged backend must actually stop after a normal quit');
    }
    await rm(directory, { recursive: true, force: true });
  }
}
