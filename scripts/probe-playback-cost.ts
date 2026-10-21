/** Bounded offline playback-cost probe: genuine packed NetEase SDK + App rclone/FUSE mount. */
import assert from 'node:assert/strict';
import { mkdtemp, open as openFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import type { ByteRange, Outcome, SourcePlugin } from '@musicfs/plugin-api';
import { parseManifest, type PluginRegistry } from '../src/core/extensions';
import { createSources } from '../src/core/sources';
import { createLibrary } from '../src/core/library';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import { createDav } from '../src/transport/dav';
import { createMountManager } from '../src/hosts/desktop/mounts';
import { createRcloneControl, type RcloneControl } from '../src/hosts/desktop/rclone-control';
import { encrypt } from '../plugins/netease/generated-upstream.mjs';
import { cover } from '../packages/audio-tags/test-fixtures';

const MiB = 1024 * 1024, KiB = 1024, delayMs = 120, bitrate = 320_000;
const profileNames = ['legacy', 'dev9', 'candidate1m'] as const;
type Profile = typeof profileNames[number];
const requested = process.argv[2];
assert(requested === undefined || profileNames.includes(requested as Profile), 'Usage: bun run scripts/probe-playback-cost.ts [legacy|dev9|candidate1m] [output.json]');
const selected: readonly Profile[] = requested === undefined ? ['legacy', 'dev9'] : [requested as Profile];
const headerOnly = process.argv[4] === 'header';
assert(process.argv[4] === undefined || headerOnly, 'The optional fourth argument is header for a 64-byte metadata-only read.');
type Transfer = { range: ByteRange | ByteRange[]; sent: number; cancelled: boolean };
type Counters = { sdkUrls: number; cdn: Transfer[]; auxiliary: number; dav: (ByteRange | null)[] };
const fresh = (): Counters => ({ sdkUrls: 0, cdn: [], auxiliary: 0, dav: [] });
const unwrap = <T>(outcome: Outcome<T>): T => { assert(outcome.ok, JSON.stringify(outcome)); return outcome.value; };
const ms = (value: number) => Math.round(value * 10) / 10;
const scratch = await mkdtemp(join(tmpdir(), 'musicfs-playback-cost-'));
const binary = resolve('dist/tools/rclone-v1.75.2-linux-amd64/rclone');
const artifact = resolve('dist/netease/org.musicfs.netease/index.mjs');
assert(await Bun.file(artifact).exists(), 'Build the NetEase plugin once before this opt-in probe; the probe never builds or downloads dependencies.');
const artifactSha256 = new Bun.CryptoHasher('sha256').update(await Bun.file(artifact).arrayBuffer()).digest('hex');
const sourcePath = join(scratch, 'source.mp3');
// One valid 320kbps MP3. Its compressed bytes are used as-is by the plugin; no format matrix.
const generated = Bun.spawn(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '180',
  '-c:a', 'libmp3lame', '-b:a', '320k', '-write_xing', '0', '-id3v2_version', '0', '-map_metadata', '-1', sourcePath], { stdout: 'ignore', stderr: 'pipe' });
assert.equal(await generated.exited, 0, await new Response(generated.stderr).text());
const source = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
assert.notEqual(new TextDecoder().decode(source.slice(0, 3)), 'ID3');
let counters = fresh();
const cdn = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
  const header = request.headers.get('range') ?? ''; assert.match(header, /^bytes=\d+-\d+(?:,\d+-\d+)*$/);
  const ranges = header.slice(6).split(',').map(value => { const [start, end] = value.split('-').map(Number); return { start: start!, end: end! }; });
  for (const range of ranges) assert(range.start >= 0 && range.end < source.length);
  const transfer: Transfer = { range: ranges.length === 1 ? ranges[0]! : ranges, sent: 0, cancelled: false }; counters.cdn.push(transfer);
  await Bun.sleep(delayMs);
  if (ranges.length > 1) {
    const boundary = 'offline-playback-preparation';
    const pieces = ranges.flatMap(range => [`--${boundary}\r\nContent-Type: audio/mpeg\r\nContent-Range: bytes ${range.start}-${range.end}/${source.length}\r\n\r\n`, source.slice(range.start, range.end + 1), '\r\n']);
    const bytes = new Uint8Array(await new Blob([...pieces, `--${boundary}--\r\n`]).arrayBuffer()); transfer.sent = bytes.length;
    return new Response(bytes, { status: 206, headers: { 'content-length': String(bytes.length), 'content-type': `multipart/byteranges; boundary=${boundary}` } });
  }
  const range = ranges[0]!;
  let position = range.start;
  return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
    if (position > range.end) { controller.close(); return; }
    // A deterministic 1MiB/s CDN model, sufficiently above the 40kB/s audio bitrate.
    await Bun.sleep(16);
    if (transfer.cancelled) return;
    const bytes = source.slice(position, Math.min(range.end + 1, position + 16 * KiB));
    position += bytes.length; transfer.sent += bytes.length; controller.enqueue(bytes);
  }, cancel() { transfer.cancelled = true; } }, { highWaterMark: 0 }), { status: 206,
    headers: { 'content-length': String(range.end - range.start + 1), 'content-range': `bytes ${range.start}-${range.end}/${source.length}` } });
} });
const api = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
  const path = new URL(request.url).pathname.replace(/^\/(eapi|weapi)\//, '/api/');
  if (path === '/api/song/enhance/player/url/v1') {
    counters.sdkUrls++; await Bun.sleep(delayMs);
    const decrypted = encrypt.eapiReqDecrypt(new URLSearchParams(await request.text()).get('params')!);
    assert(decrypted); const ids = JSON.parse(String(decrypted.data.ids)) as number[];
    return Response.json({ code: 200, data: ids.map(id => ({ id, level: decrypted.data.level, type: 'mp3',
      url: `https://m1.music.126.net/fixture-${counters.sdkUrls}.mp3`, expi: 1200, md5: 'a'.repeat(32), size: source.length })) });
  }
  if (path === '/api/login/qrcode/unikey') return Response.json({ code: 200, unikey: 'offline-qr' });
  if (path === '/api/login/qrcode/client/login') return Response.json({ code: 803 }, { headers: { 'set-cookie': 'MUSIC_U=offline-fixture; Domain=.music.163.com; Path=/; Secure; Expires=Thu, 31 Dec 2099 23:59:59 GMT' } });
  if (path === '/api/w/nuser/account/get') return Response.json({ code: 200, profile: { userId: 42, nickname: 'Offline' } });
  if (path === '/api/user/playlist') return Response.json({ code: 200, more: false, playlist: [{ id: 8, userId: 42, specialType: 5 }] });
  if (path === '/api/v6/playlist/detail') return Response.json({ code: 200, playlist: { trackIds: [{ id: 1 }], trackCount: 1, tracks: [] } });
  if (path === '/api/song/detail/') return Response.json({ code: 200, songs: [{ id: 1, name: 'Offline playback', artists: [{ name: 'Artist' }], no: 1, disc: '1',
    album: { id: 1, name: 'Album', picUrl: 'https://p1.music.126.net/cover.png', artists: [{ name: 'Artist' }], publishTime: 1577836800000, size: 1 } }] });
  if (path === '/api/song/lyric/v1') { counters.auxiliary++; return Response.json({ code: 200, lrc: { lyric: '[00:00.00]Offline lyric' } }); }
  if (path === '/cover.png') { counters.auxiliary++; return new Response(cover, { headers: { 'content-type': 'image/png' } }); }
  throw new Error(`Unhandled offline SDK path ${path}`);
} });
const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init); const url = new URL(request.url);
  assert(['music.163.com', 'interface.music.163.com', 'm1.music.126.net', 'p1.music.126.net'].includes(url.hostname), 'No real network fallback');
  const destination = new URL(url.pathname + url.search, url.hostname === 'm1.music.126.net' ? cdn.url : api.url);
  const response = await fetch(new Request(destination, request));
  // Bun's loopback server switches delayed large streams to chunked encoding. This controlled
  // source has a known exact extent; expose the Content-Length that the real CDN contract requires.
  if (url.hostname === 'm1.music.126.net' && !response.headers.has('content-length')) {
    const extent = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? ''); assert(extent);
    const headers = new Headers(response.headers); headers.delete('transfer-encoding'); headers.set('content-length', String(Number(extent[2]) - Number(extent[1]) + 1));
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}) as typeof fetch;
const packed = (await import(pathToFileURL(artifact).href) as { default: SourcePlugin }).default;
const plugin: SourcePlugin = { ...packed, async open(ctx, file, request) {
  const result = await packed.open(ctx, file, request);
  if (!result.ok) console.error(JSON.stringify({ fixturePluginError: result.error, range: request.range }));
  return result;
} };
const store = openSqlite(join(scratch, 'state.sqlite'));
const installation = store.activate(parseManifest(await Bun.file('plugins/netease/manifest.json').json(), 'desktop'), 'a'.repeat(64), null);
const registry: PluginRegistry = { get: async () => ({ ...installation, module: plugin }), isCurrent: async () => true };
const sources = createSources(store, registry, transport); const signal = new AbortController().signal;
const library = createLibrary(sources, store);
let profile: Profile = 'dev9';
const applied = new Map<Profile, { bufferKiB: number; initialChunkKiB: number; cacheMode: unknown }>();
const control = createRcloneControl({ directory: join(scratch, 'control'), binary });
const comparison: RcloneControl = { ...control, async call<T>(method: string, parameters: Record<string, unknown> = {}) {
  if (method === 'mount/mount' && profile === 'legacy') parameters = { ...parameters, _config: { BufferSize: 16 * MiB },
    vfsOpt: { ...parameters.vfsOpt as object, ChunkSize: 128 * MiB } };
  if (method === 'mount/mount' && profile === 'dev9') parameters = { ...parameters, _config: { BufferSize: 128 * KiB },
    vfsOpt: { ...parameters.vfsOpt as object, ChunkSize: 256 * KiB } };
  if (method === 'mount/mount' && profile === 'candidate1m') parameters = { ...parameters, vfsOpt: { ...parameters.vfsOpt as object, ChunkSize: MiB } };
  if (method === 'mount/mount') parameters = { ...parameters, _config: { ...parameters._config as object, LowLevelRetries: 1 } };
  if (method === 'mount/mount') {
    const config = parameters._config as { BufferSize: number }; const vfs = parameters.vfsOpt as { ChunkSize: number; CacheMode: unknown };
    applied.set(profile, { bufferKiB: config.BufferSize / KiB, initialChunkKiB: vfs.ChunkSize / KiB, cacheMode: vfs.CacheMode });
    assert.equal(vfs.CacheMode, 'full', 'Both profiles must keep production full-cache semantics');
  }
  return control.call<T>(method, parameters);
} };
const dav = createDav(library.files, { username: 'reader', password: 'offline' });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch(request) {
  if (request.method === 'GET') {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('range') ?? '');
    counters.dav.push(match ? { start: Number(match[1]), end: Number(match[2]) } : null);
  }
  return dav.fetch(request);
} });
const manager = await createMountManager({ directory: join(scratch, 'mounts'), binary, control: comparison,
  localConnection: () => ({ url: new URL('/dav/', server.url).href, username: 'reader', password: 'offline' }) });
const result: unknown[] = [];
try {
  const created = unwrap(await sources.create(installation.manifest.id, 'Offline', {}, signal));
  const initial = unwrap(await sources.authenticate(created.id, { kind: 'start' }, signal));
  assert(initial.step?.kind === 'waiting');
  const authorized = unwrap(await sources.authenticate(created.id, { kind: 'poll', operationId: initial.operationId, challengeId: initial.step.challengeId }, signal));
  assert.equal(authorized.step?.kind, 'complete');
  await library.refresh(created.id, undefined, signal); await library.refresh(created.id, 'liked', signal);
  const directory = '/Offline/喜欢的歌曲'; const entries = await library.files.list(directory, signal);
  assert.equal(entries.length, 1); const entry = entries[0]!; const descriptor = await library.files.stat(entry, signal); assert.equal(descriptor.kind, 'file');
  counters = fresh(); const prepareStarted = performance.now();
  assert(descriptor.kind === 'file');
  const headerRead = await library.files.open(descriptor, { start: 0, end: 9 }, signal);
  const header = new Uint8Array(await new Response(headerRead.body).arrayBuffer());
  const audioStart = 10 + header.slice(6, 10).reduce((size, byte) => size * 128 + byte, 0);
  assert.equal(audioStart, MiB);
  const preparation = { milliseconds: ms(performance.now() - prepareStarted), sdkUrls: counters.sdkUrls, cdnRequests: counters.cdn.length, auxiliary: counters.auxiliary };
  // Resolve one source-backed window before FUSE: fixture errors must fail immediately, not enter rclone's retry loop.
  const checked = await library.files.open(descriptor, { start: audioStart, end: audioStart + MiB - 1 }, signal);
  const checkedReader = checked.body.getReader(); const checkedFirst = await checkedReader.read(); assert(!checkedFirst.done);
  assert.deepEqual(checkedFirst.value, source.slice(0, checkedFirst.value.length)); await checkedReader.cancel();
  const summarize = () => ({ sdkUrls: counters.sdkUrls, cdnRequests: counters.cdn.length, sourceBytes: counters.cdn.reduce((total, item) => total + item.sent, 0),
    sourceRanges: counters.cdn.map(item => item.range), davRanges: counters.dav, auxiliary: counters.auxiliary });
  for (const current of selected) {
    profile = current; counters = fresh();
    const mounted = await manager.mount({ mountPoint: join(scratch, current), source: { kind: 'local' } }); assert.equal(mounted.state, 'mounted', JSON.stringify(mounted.error));
    const path = join(mounted.mountPoint, 'Offline', '喜欢的歌曲'); const names = await readdir(path); assert.equal(names.length, 1);
    console.error(JSON.stringify({ profile: current, stage: 'native-playback-start' }));
    const started = performance.now(); const fd = await openFile(join(path, names[0]!), 'r'); const waits: number[] = []; let consumed = 0;
    const read = async (position: number, size: number) => {
      const data = new Uint8Array(size), before = performance.now(); const read = await fd.read(data, 0, size, position);
      const wait = performance.now() - before; assert.equal(read.bytesRead, size);
      if (position >= audioStart) assert.deepEqual(data, source.slice(position - audioStart, position - audioStart + size));
      return wait;
    };
    if (headerOnly) {
      let headerMs: number;
      try { headerMs = await read(0, 64); await Bun.sleep(120); } finally { await fd.close(); }
      await Bun.sleep(40);
      const metrics = summarize(); result.push({ profile: current, ...applied.get(current), headerMs: ms(headerMs), ...metrics });
      assert.equal(metrics.sdkUrls, 0, 'A prepared one-MiB tag read must not resolve source audio');
      assert.equal(metrics.cdnRequests, 0, 'A prepared one-MiB tag read must not open source audio');
      await manager.unmount(mounted.id); continue;
    }
    let firstAudioMs: number, seekMs: number;
    try {
      await read(0, 64); firstAudioMs = await read(audioStart, 64 * KiB); consumed += 64 * KiB;
      for (let position = audioStart + 64 * KiB; position < audioStart + 3 * MiB; position += 64 * KiB) { waits.push(await read(position, 64 * KiB)); consumed += 64 * KiB; }
      const seekPosition = audioStart + 5 * MiB; seekMs = await read(seekPosition, 64 * KiB); consumed += 64 * KiB;
      for (let position = seekPosition + 64 * KiB; position < audioStart + source.length; position += 64 * KiB) {
        const size = Math.min(64 * KiB, audioStart + source.length - position); waits.push(await read(position, size)); consumed += size;
      }
    } finally { await fd.close(); }
    await Bun.sleep(40);
    const metrics = summarize();
    result.push({ profile: current, ...applied.get(current),
      firstAudioMs: ms(firstAudioMs), seekMs: ms(seekMs), sequentialReadMaxMs: ms(Math.max(...waits)),
      sequentialReadMs: ms(waits.reduce((sum, wait) => sum + wait, 0)), audioConsumedBytes: consumed,
      equivalentAudioSeconds: ms(consumed * 8 / bitrate), elapsedMs: ms(performance.now() - started),
      // The consumer is deliberately faster than real time; compare each 64KiB read to its 1.638s playback window.
      sixtyFourKiBPlaybackWindowMs: ms(64 * KiB * 8 / bitrate * 1000),
      readsExceedingPlaybackWindow: waits.filter(wait => wait > 64 * KiB * 8 / bitrate * 1000).length, ...metrics });
    assert.equal(metrics.auxiliary, 0, 'Prepared tags must not fetch lyrics/artwork again');
    await manager.unmount(mounted.id);
  }
  const report = { runtime: 'WSL native FUSE + production mount manager/rclone1.75.2 + Library/DAV/SQLite + existing packed NetEase SDK; loopback HTTP only',
    sample: { codec: 'MP3', bitrateBitsPerSecond: bitrate, nominalSeconds: 180, sourceBytes: source.length, sourceRequestDelayMs: delayMs,
      urlResolutionDelayMs: delayMs, cdnBytesPerSecond: MiB, consumed: headerOnly ? 'one64-byte header read,120ms observation,close' : 'first3MiB, one forward seek to5MiB, then through EOF; 64KiB fast consumer' },
    artifactSha256, preparation, result, limits: ['offline fixed-delay model; not a real platform latency/rate-limit assertion', 'same-handle native reads; no GUI/decoder playback claim',
      'cold VFS for both profiles; permanent tagged plan already prepared', 'loopback delayed stream Content-Length restored from its declared Content-Range before SDK delivery'] };
  console.log(JSON.stringify(report)); await Bun.write(process.argv[3] ?? (requested ? `.musicfs/playback-cost-${requested}-result.json` : '.musicfs/playback-cost-result.json'), JSON.stringify(report, null, 2) + '\n');
} finally {
  await manager.close(); await server.stop(true); await api.stop(true); await cdn.stop(true); store.close(); await rm(scratch, { recursive: true, force: true });
}
