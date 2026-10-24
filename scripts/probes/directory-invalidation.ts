/** Bounded native VFS check: no platform, FUSE/WinFsp, Windows host or cloud. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Description, FileView } from '../../src/core/library';
import { createDav } from '../../src/transport/dav';
import { createRcloneControl } from '../../src/hosts/desktop/rclone-control';

const scratch = await mkdtemp(join(tmpdir(), 'musicfs-directory-update-'));
const control = createRcloneControl({ directory: scratch, binary: resolve('dist/tools/rclone-v1.75.2-linux-amd64/rclone') });
const time = '2026-10-23T00:00:00.000Z';
const stamp = { id: 'fixture', pluginId: 'fixture', epoch: 1, pluginRevision: 'fixture', pluginGeneration: 1 };
const directories = new Set(['/', '/a', '/a/sub', '/b']);
const files = new Map(['/a/keep.wav', '/a/remove.wav', '/a/sub/child.wav', '/b/other.wav'].map(path => [path, { body: 'abcdefgh', time }]));
const lists: Record<string, number> = {}; let opens = 0, requests = 0;
const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
function describe(path: string): Description {
  const base = { path, name: path.split('/').at(-1) ?? '', etag: path, modifiedAt: time };
  if (directories.has(path)) return { ...base, kind: 'directory' };
  const file = files.get(path); assert(file, `Missing fixture file ${path}`);
  const content = { contentId: file.body, size: file.body.length, mediaType: 'audio/wav', modifiedAt: file.time };
  return { ...base, kind: 'file', etag: file.body, modifiedAt: file.time, handle: { stamp, fileRef: path, content } };
}
const view: FileView = {
  async stat(entry) { return describe(typeof entry === 'string' ? entry : entry.path); },
  async list(path) {
    lists[path] = (lists[path] ?? 0) + 1;
    return [...directories, ...files.keys()].filter(value => value !== path && parent(value) === path).map(describe);
  },
  async statMany(entries) { return new Map(entries.map(entry => [entry, describe(entry.path)])); },
  async open(file, range) {
    opens++; const data = files.get(file.handle.fileRef)!.body;
    return { content: file.handle.content, servedRange: range ?? null,
      body: new Blob([range ? data.slice(range.start, range.end + 1) : data]).stream() };
  }
};
const dav = createDav(view, { username: 'reader', password: 'fixture' });
const origin = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch(request) { requests++; return dav.fetch(request); } });
const remote = 'musicfs_listing_probe:'; let serving: string | undefined;
try {
  await control.call('config/create', { name: remote.slice(0, -1), type: 'webdav', parameters: {
    url: new URL('/dav/', origin.url).href, vendor: 'rclone', user: 'reader', pass: 'fixture' }, opt: { obscure: true, nonInteractive: true } });
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null) });
  const port = reservation.port; await reservation.stop(true);
  const server = await control.call<{ id: string; addr: string }>('serve/start', { type: 'webdav', fs: remote, addr: `127.0.0.1:${port}`,
    _config: { LowLevelRetries: 1, BufferSize: 128 * 1024 },
    vfsOpt: { ReadOnly: true, CacheMode: 'full', HandleCaching: '0s', DirCacheTime: '8760h', ChunkSize: 1024 * 1024 } });
  serving = server.id;
  const url = `http://${server.addr}`;
  const listing = async (path: string) => {
    const response = await fetch(`${url}${path === '/' ? '/' : path + '/'}`, { method: 'PROPFIND', headers: { Depth: '1' } });
    assert.equal(response.status, 207); return response.text();
  };
  const read = async () => {
    const response = await fetch(`${url}/a/keep.wav`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(response.status, 206); return response.text();
  };
  await listing('/a'); await listing('/a/sub'); await listing('/b');
  assert.equal(await read(), 'abcd');
  const before = { lists: { ...lists }, opens, requests };
  files.delete('/a/remove.wav'); files.set('/a/new.wav', { body: 'new-song', time });
  await control.call('vfs/forget', { fs: remote, file: 'a/new.wav' });
  assert.equal(requests, before.requests, 'Invalidation must not fetch or warm any directory');
  const updated = await listing('/a');
  assert(updated.includes('new.wav')); assert(!updated.includes('remove.wav'));
  await listing('/a/sub'); await listing('/b');
  assert.equal(lists['/a'], before.lists['/a']! + 1);
  assert.equal(lists['/a/sub'], before.lists['/a/sub']); assert.equal(lists['/b'], before.lists['/b']);
  assert.equal(await read(), 'abcd'); assert.equal(opens, before.opens, 'Unchanged ranges must remain cached');
  files.set('/a/keep.wav', { body: 'ABCDEFGH', time: '2026-10-23T00:01:00.000Z' });
  await control.call('vfs/forget', { fs: remote, file: 'a/keep.wav' });
  assert.equal(await read(), 'ABCD'); assert.equal(opens, before.opens + 1);
  directories.add('/c');
  await control.call('vfs/forget', { fs: remote, file: 'c' });
  assert((await listing('/')).includes('/c/'));
  await listing('/a/sub'); await listing('/b');
  assert.equal(lists['/a/sub'], before.lists['/a/sub']); assert.equal(lists['/b'], before.lists['/b']);
  const evidence = { scope: 'real rclone 1.75.2 VFS + MusicFS DAV + native file-form notification, loopback synthetic files; no OS mount',
    success: true, invalidationOriginRequests: 0, changedListingReads: 1, unchangedChildListingReads: 0,
    unrelatedListingReads: 0, unchangedRangeSourceOpens: 0, changedRangeSourceOpens: 1, rootListingPreservesChildren: true };
  console.log(JSON.stringify(evidence));
} finally {
  if (serving) await control.call('serve/stop', { id: serving });
  await control.close(); await origin.stop(true); await rm(scratch, { recursive: true, force: true });
}
