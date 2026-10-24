/** Opt-in WSL/FUSE regression: tiny metadata reads must not download megabytes of audio. No platform traffic. */
import assert from 'node:assert/strict';
import { mkdtemp, open as openFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { libraryFixture } from '../../tests/helpers/library-fixture';
import { createDav } from '../../src/transport/dav';
import { createMountManager } from '../../src/hosts/desktop/mounts';
import { createRcloneControl, type RcloneControl } from '../../src/hosts/desktop/rclone-control';
import { open, type TaggedPlan, type ReadRange } from '../../packages/audio-tags/src';
import type { ByteRange, SourcePlugin } from '@musicfs/plugin-api';

const MiB = 1024 * 1024, sourceSize = 64 * MiB, padding = MiB;
const sourceInfo = { contentId: 'offline-source', size: sourceSize, mediaType: 'audio/mpeg' };
const content = { ...sourceInfo, contentId: 'offline-final', size: sourceSize + padding, modifiedAt: '2026-10-21T00:00:00.000Z' };
let sourceByte = 0x5a;
const plan: TaggedPlan = { version: 1, format: 'mp3', source: sourceInfo, content,
  segments: [{ kind: 'zeros', size: padding }, { kind: 'source', start: 0, end: sourceSize - 1 }] };
const profiles = ['legacy', 'buffer-only', 'current'] as const;
type Stats = { sourceBytes: number; sourceRanges: ByteRange[]; davRanges: (ByteRange | null)[] };
const stats = new Map<string, Stats>();
const fresh = (): Stats => ({ sourceBytes: 0, sourceRanges: [], davRanges: [] });

// Use actual HTTP between the tag reader and a simulated CDN: an in-memory stream alone
// misses transport read-ahead. Count the requested range as well as bytes sent by this server.
const cdn = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch(request) {
  const name = new URL(request.url).pathname.slice(1), current = stats.get(name)!;
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('range') ?? '');
  assert(match); const range = { start: Number(match[1]), end: Number(match[2]) };
  current.sourceRanges.push(range); let offset = range.start;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset > range.end) { controller.close(); return; }
    const size = Math.min(64 * 1024, range.end - offset + 1);
    const data = new Uint8Array(size).fill(sourceByte); offset += size; current.sourceBytes += size; controller.enqueue(data);
  } }, { highWaterMark: 0 }), { status: 206, headers: { 'Content-Length': String(range.end - range.start + 1),
    'Content-Range': `bytes ${range.start}-${range.end}/${sourceSize}` } });
} });
const plugin: SourcePlugin = {
  configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, value) => ({ ok: true, value }),
  roots: async () => ({ ok: true, value: { items: [{ sourceId: 'root', name: 'Reads', directoryRef: 'root' }] } }),
  list: async () => ({ ok: true, value: { items: profiles.map(name => ({ kind: 'file' as const, entryId: name, name: `${name}.mp3`, fileRef: name, info: content })) } }),
  stat: async () => ({ ok: true, value: content }),
  async open(ctx, name, request) {
    stats.get(name)!.davRanges.push(request.range ?? null);
    const reader: ReadRange = async (range, signal) => {
      const response = await fetch(new URL(name, cdn.url), { headers: { Range: `bytes=${range.start}-${range.end}` }, signal });
      assert.equal(response.status, 206);
      return { content: sourceInfo, servedRange: range, body: response.body! };
    };
    return { ok: true, value: await open(plan, reader, request.range, ctx.signal) };
  }
};
const f = await libraryFixture(plugin), scratch = await mkdtemp(join(tmpdir(), 'musicfs-mount-reads-'));
const dav = createDav(f.library.files, { username: 'reader', password: 'fixture' });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: dav.fetch });
const control = createRcloneControl({ directory: join(scratch, 'control'), binary: resolve('dist/tools/rclone-v1.75.2-linux-amd64/rclone') });
let profile: typeof profiles[number] = 'current';
const comparison: RcloneControl = { ...control, async call<T>(method: string, parameters: Record<string, unknown> = {}) {
  // Preserve the production composition; override just the two controls under investigation for the old baselines.
  if (method === 'mount/mount' && profile !== 'current') parameters = { ...parameters,
    _config: { BufferSize: profile === 'legacy' ? 16 * MiB : 128 * 1024 },
    vfsOpt: { ...parameters.vfsOpt as object, CacheMode: 'off', ChunkSize: 128 * MiB, ChunkSizeLimit: -1 } };
  return control.call<T>(method, parameters);
} };
const manager = await createMountManager({ directory: join(scratch, 'mounts'), binary: 'unused', control: comparison,
  localConnection: () => ({ url: new URL('/dav/', server.url).href, username: 'reader', password: 'fixture' }) });
const report: unknown[] = [];
try {
  await f.library.refresh(f.id, undefined, new AbortController().signal); await f.library.refresh(f.id, 'root', new AbortController().signal);
  for (const name of profiles) {
    profile = name; stats.set(name, fresh());
    const mounted = await manager.mount({ mountPoint: join(scratch, name), source: { kind: 'local' } });
    assert.equal(mounted.state, 'mounted', JSON.stringify(mounted.error));
    const path = join(mounted.mountPoint, '实例 & #', 'Reads'); await readdir(path);
    const file = join(path, `${name}.mp3`);
    const read = async (position: number) => {
      const fd = await openFile(file, 'r');
      try { const data = new Uint8Array(64); assert.equal((await fd.read(data, 0, data.length, position)).bytesRead, 64);
        assert(data.every(byte => byte === (position < padding ? 0 : sourceByte)), JSON.stringify({ profile: name, position, expected: position < padding ? 0 : sourceByte, actual: data[0], stats: stats.get(name) })); await Bun.sleep(120);
      } finally { await fd.close(); }
      await Bun.sleep(30);
    };
    await read(0); const header = structuredClone(stats.get(name)!);
    if (name === 'current') {
      // A fresh handle at a different offset models a tag reader seeking to a trailer.
      stats.set(name, fresh()); await read(content.size - 128); const trailer = structuredClone(stats.get(name)!);
      // Recreate the actual FUSE/VFS to rule out the kernel page cache or a surviving open handle.
      await manager.remount(mounted.id); stats.set(name, fresh()); await read(0); await read(content.size - 128);
      const reopened = structuredClone(stats.get(name)!);
      assert.equal(reopened.davRanges.length, 0, 'Previously read fragments must survive a real remount without another DAV GET');
      // Sequential consumption must still grow chunks, rather than issuing 256KiB requests for the entire song.
      stats.set(name, fresh()); const fd = await openFile(file, 'r'); let bytes = 0;
      try { const data = new Uint8Array(256 * 1024); for (;;) {
        const result = await fd.read(data, 0, data.length, bytes); if (!result.bytesRead) break;
        for (let i = 0; i < result.bytesRead; i++) assert.equal(data[i], bytes + i < padding ? 0 : 0x5a);
        bytes += result.bytesRead;
      } } finally { await fd.close(); }
      const sequential = structuredClone(stats.get(name)!); assert.equal(bytes, content.size);
      // A normal published version change at the same path/size must invalidate cached bytes.
      sourceByte = 0x6b; sourceInfo.contentId = 'offline-source-v2'; content.contentId = 'offline-final-v2'; content.modifiedAt = '2026-10-22T00:00:00.000Z';
      await f.library.refresh(f.id, 'root', new AbortController().signal);
      const updatedHead = await fetch(new URL(`/dav/${encodeURIComponent('实例 & #')}/Reads/${name}.mp3`, server.url), {
        method: 'HEAD', headers: { Authorization: `Basic ${btoa('reader:fixture')}` }
      });
      assert.equal(updatedHead.headers.get('last-modified'), new Date(content.modifiedAt).toUTCString(), 'Published file time must reflect the updated version');
      await manager.remount(mounted.id); stats.set(name, fresh()); await read(content.size - 128);
      const updated = structuredClone(stats.get(name)!); assert(updated.sourceRanges.length > 0, 'A changed file version must not reuse old audio bytes');
      report.push({ profile: name, header, trailer, reopened, sequential: { bytes, ...sequential }, updated });
      assert.equal(header.sourceRanges.length, 0, 'A tiny read of cached tags must not open the audio source');
      assert(trailer.sourceRanges.every(range => range.end - range.start + 1 <= 256 * 1024));
      assert(sequential.davRanges.length <= 10, 'Sequential playback must use growing chunks');
    } else report.push({ profile: name, header });
    await manager.unmount(mounted.id);
  }
} finally {
  await manager.close(); await server.stop(true); await cdn.stop(true); f.close(); await rm(scratch, { recursive: true, force: true });
  const evidence = { runtime: 'actual WSL FUSE + production rclone/mount manager + Library/DAV/SQLite + audio-tag segment reader + simulated HTTP CDN; generated bytes, no decoder or platform', report };
  console.log(JSON.stringify(evidence)); await Bun.write('.musicfs/mount-reads-result.json', JSON.stringify(evidence, null, 2) + '\n');
}
