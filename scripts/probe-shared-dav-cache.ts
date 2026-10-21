/** Bounded production shared-cache verification: generated audio, no platform or mount driver. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDav } from '../src/transport/dav';
import { createRcloneControl } from '../src/hosts/desktop/rclone-control';
import { createDesktopReadCache } from '../src/hosts/desktop/read-cache';
import { createReadCacheFixture } from './helpers/read-cache-fixture';

const scratch = await mkdtemp(join(tmpdir(), 'musicfs-shared-dav-'));
const fixture = await createReadCacheFixture();
const credentials = { username: 'reader', password: 'fixture' };
const controlDirectory = join(scratch, 'rclone');
const control = createRcloneControl({ directory: controlDirectory, binary: resolve('dist/tools/rclone-v1.75.2-linux-amd64/rclone') });
let allowed = true;
const input = { directory: join(scratch, 'read-cache'), controlDirectory, control, view: fixture.files, current: () => allowed };
let cache = await createDesktopReadCache(input);
const publicServer = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0,
  fetch: request => createDav(cache.files, credentials).fetch(request) });
const url = new URL(new URL(fixture.url).pathname, publicServer.url).href;
const headers = { Authorization: `Basic ${btoa('reader:fixture')}` };
const reports: unknown[] = [];
const snapshot = async (operation: string) => { await Bun.sleep(100); reports.push({ operation, ...fixture.snapshot() }); };
const get = async (start: number, end: number) => {
  const response = await fetch(url, { headers: { ...headers, Range: `bytes=${start}-${end}` } }); assert.equal(response.status, 206);
  const bytes = new Uint8Array(await response.arrayBuffer()); assert.equal(bytes.length, end - start + 1); return bytes;
};
try {
  assert.equal((await cache.inspect()).state, 'inactive');
  for (let pass = 0; pass < 2; pass++) {
    fixture.reset(); const before = performance.now();
    const child = Bun.spawn(['ffprobe', '-v', 'error', '-headers', `Authorization: Basic ${btoa('reader:fixture')}\r\n`,
      '-show_entries', 'format=duration:format_tags=title', '-of', 'json', url], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, err); const metadata = JSON.parse(out); assert.equal(metadata.format.tags.title, 'Cache fixture title');
    reports.push({ operation: pass ? 'repeat-ffprobe' : 'first-ffprobe', milliseconds: performance.now() - before, metadata, ...fixture.snapshot() });
    await Bun.sleep(100);
  }
  // Fill an exact finite range once, then repeat/overlap it across genuine VFS recreation.
  fixture.reset();
  const first = await get(0, 3 * 1024 * 1024 - 1); await snapshot('finite-first');
  fixture.reset(); assert.deepEqual(await get(512 * 1024, 3 * 1024 * 1024 - 1), first.slice(512 * 1024));
  await snapshot('finite-overlap'); assert.equal(fixture.snapshot().source.length, 0);
  const expected = await fixture.expected(); const tail = expected.samples[1]!;
  assert.equal(Buffer.from(await get(tail.offset, tail.offset + 63)).toString('base64'), tail.base64);
  await cache.close(); cache = await createDesktopReadCache(input);
  fixture.reset(); assert.deepEqual(await get(0, first.length - 1), first);
  assert.equal(Buffer.from(await get(tail.offset, tail.offset + 63)).toString('base64'), tail.base64);
  await snapshot('after-vfs-recreation'); assert.equal(fixture.snapshot().source.length, 0);
  const status = await cache.inspect(); assert.equal(status.actualMode, 'full');
  const previousHead = await fetch(url, { method: 'HEAD', headers });
  const originalSize = previousHead.headers.get('content-length'), originalTime = previousHead.headers.get('last-modified');
  await fixture.reviseTitle('Changed cache title'); fixture.reset();
  const updatedHead = await fetch(url, { method: 'HEAD', headers });
  assert.equal(updatedHead.headers.get('content-length'), originalSize); assert.equal(updatedHead.headers.get('last-modified'), originalTime);
  assert.notEqual(updatedHead.headers.get('etag'), previousHead.headers.get('etag'));
  const changedHeader = await get(0, 1024 * 1024 - 1);
  assert.notDeepEqual(changedHeader, first.slice(0, 1024 * 1024));
  await snapshot('same-path-size-and-time-new-identity'); assert.equal(fixture.snapshot().preparations, 1);
  allowed = false; fixture.reset(); const stale = await fetch(url, { headers: { ...headers, Range: 'bytes=0-63' } });
  assert.equal(stale.status, 503); await stale.body?.cancel(); assert.equal(fixture.snapshot().source.length, 0);
  reports.push({ operation: 'stale-source-gate', status: stale.status, ...fixture.snapshot() }); allowed = true;
  // One active read must keep the cache intact when the user requests clearing.
  const file = await fixture.files.stat('/实例 & #/Music/Track 1.mp3', new AbortController().signal); assert.equal(file.kind, 'file');
  if (file.kind !== 'file') throw new Error('Missing fixture');
  const resume = cache.prepareQuit();
  await assert.rejects(() => cache.files.open(file, { start: 0, end: 63 }, new AbortController().signal), /stopping/); resume();
  const held = await cache.files.open(file, { start: 0, end: 63 }, new AbortController().signal);
  await assert.rejects(() => cache.clear(), /正在读取/); await held.body.cancel();

  await cache.clear(); fixture.reset(); await get(tail.offset, tail.offset + 63);
  await snapshot('after-clear'); assert(fixture.snapshot().source.length > 0);
  await cache.configure({ maxMiB: 0, maxAgeHours: 0 }); fixture.reset(); await get(tail.offset, tail.offset + 63);
  await snapshot('disabled'); assert(fixture.snapshot().source.length > 0);
  const evidence = { scope: 'production shared read-cache + rclone1.75.2 + Library/DAV/audio-tags + actual FFprobe + synthetic MP3; no platform or mount driver', success: true, status, reports };
  await Bun.write('.musicfs/shared-dav-proof.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
} finally { await publicServer.stop(true); await cache.close(); await control.close(); await fixture.close(); await rm(scratch, { recursive: true, force: true }); }
