import assert from 'node:assert/strict';
import { access, mkdtemp, rm, mkdir, open, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { requestReady } from './helpers/refresh-http';

// Runs a generated native release, rather than src/desktop.ts or the dev service.
const { values } = parseArgs({ args: Bun.argv.slice(2), options: { directory: { type: 'string' }, 'keep-running': { type: 'boolean' }, mount: { type: 'boolean' } } });
const release = resolve(values.directory ?? 'dist/desktop/linux-x64');
const metadata = await Bun.file(join(release, 'release.json')).json() as { target: string; executable: string };
const native = `${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`;
assert.equal(metadata.target, native, 'Run each release probe on its native target system');
const directory = await mkdtemp(join(tmpdir(), 'musicfs-desktop-product-'));
const executable = join(release, metadata.executable);
let origin = ''; let token = ''; let keptForBrowser = false;
const launch = async () => {
  const child = Bun.spawn([executable, '--no-open', '--data', directory], { stdout: 'pipe', stderr: 'pipe' });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  assert.equal(code, 0, error);
  return child.pid;
};
try {
  const frontPid = await launch();
  const runtime = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')) as { pid: number; origin: string };
  const credentials = JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8')) as { adminToken: string; username: string; password: string };
  origin = runtime.origin; token = credentials.adminToken;
  assert.notEqual(frontPid, runtime.pid);
  const admin = { Authorization: `Bearer ${token}` };
  const json = { ...admin, 'Content-Type': 'application/json' };
  const page = await fetch(origin); assert.equal(page.status, 200); assert((await page.text()).includes('<div id="root">'));
  const initial = await fetch(origin + '/api/plugins', { headers: admin }); assert.deepEqual(await initial.json(), []);
  const installed = await fetch(origin + '/api/plugins', { method: 'POST', headers: admin, body: await Bun.file(join(release, 'plugins/org.musicfs.sample.zip')).arrayBuffer() });
  assert.equal(installed.status, 201); await installed.body?.cancel();
  const created = await fetch(origin + '/api/instances', { method: 'POST', headers: json,
    body: JSON.stringify({ pluginId: 'org.musicfs.sample', name: '发行物测试', config: { label: '已知音频' } }) });
  assert.equal(created.status, 201); await created.body?.cancel();
  const file = origin + '/dav/' + ['发行物测试', '已知音频', '440 Hz.wav'].map(encodeURIComponent).join('/');
  const dav = { Authorization: 'Basic ' + btoa(`${credentials.username}:${credentials.password}`) };
  const head = await requestReady((url, init) => fetch(url, init), file, { method: 'HEAD', headers: dav }, admin);
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '16044');
  const range = await fetch(file, { headers: { ...dav, Range: 'bytes=0-3' } }); assert.equal(range.status, 206); assert.equal(await range.text(), 'RIFF');
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
    const removed = await fetch(origin + '/api/mounts/' + failed.id, { method: 'DELETE', headers: admin });
    assert.equal(removed.status, 200); assert.equal((await removed.json() as { state: string }).state, 'stopped');
    dependencyFailureTested = true;
  }
  let systemMountTested = false;
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
    const held = await open(path, 'r');
    try {
      const busy = await fetch(origin + '/api/mounts/' + state.id, { method: 'DELETE', headers: admin });
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
    externalPluginInstalled: true, davHead: 16044, exactRange: 'RIFF', repeatedLaunchReused: true,
    mountsEndpoint: true, dependencyFailureTested, systemMountTested, ...(systemMountTested ? { mountedBytes: 16044, mountedRanges: 5 } : {}),
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
