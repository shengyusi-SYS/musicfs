import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { buildNetease } from '../build-netease';
import { workerCrypto } from '../helpers/worker-crypto';
import { encrypt } from '../../plugins/netease/generated-upstream.mjs';
import type { RefreshView } from '../../src/contracts/refreshes';
import { cover } from '../../packages/audio-tags/test-fixtures';
import { parseBuffer } from 'music-metadata';
import type { Entry } from '@musicfs/plugin-api';
import type { ContentSources, ViewEntry } from '../../src/contracts/management';

const tracks = Number(process.argv[2] ?? 24);
assert(process.argv.length <= 3 && [24, 200].includes(tracks), 'Usage: bun run scripts/probes/netease-refresh-offline.ts [24|200]');
await buildNetease();
const root = await mkdtemp(join(tmpdir(), 'musicfs-netease-refresh-'));
const source = new Uint8Array(await Bun.file('tests/fixtures/source-metadata/source.mp3').arrayBuffer());
const picture = new Uint8Array(32_768); picture.set(cover);
const ids = Array.from({ length: tracks }, (_, i) => i + 1);
const song = (id: number) => ({ id, name: `Song ${id}`, ar: [{ name: 'Artist' }], al: { id: 1, name: 'Album', picUrl: 'https://p1.music.126.net/cover.png' }, no: id, cd: '1' });
const richSong = (id: number) => ({ id, name: `Song ${id}`, artists: [{ name: 'Artist' }],
  album: { id: 1, name: 'Album', picUrl: 'https://p1.music.126.net/cover.png', artists: [{ name: 'Artist' }], publishTime: 1577836800000, size: ids.length }, no: id, disc: '1' });
let requests = 0;
const calls: Record<string, number> = {};
await Bun.write(join(root, 'netease.mjs'), Bun.file('dist/netease/org.musicfs.netease/index.mjs'));
const build = await Bun.build({ entrypoints: ['tests/probes/worker-netease-refresh.ts'], target: 'browser', format: 'esm', outdir: root, naming: 'worker.mjs',
  plugins: [workerCrypto, { name: 'packed-netease', setup(builder) { builder.onResolve({ filter: /^musicfs-netease-artifact$/ }, () => ({ path: './netease.mjs', external: true })); } }] });
if (!build.success) throw new AggregateError(build.logs, 'Offline Worker refresh build failed');
// The packed artifact is an explicit module; no plugin or platform code is downloaded.
const mf = new Miniflare({ modulesRoot: root, modules: [{ type: 'ESModule', path: join(root, 'worker.mjs') }, { type: 'ESModule', path: join(root, 'netease.mjs') }],
  compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'netease-refresh' }, d1Persist: join(root, 'db'),
  outboundService: async (request: Request) => {
    requests++; const url = new URL(request.url); const path = url.pathname.replace(/^\/(eapi|weapi)\//, '/api/'); calls[path] = (calls[path] ?? 0) + 1;
    if (url.hostname === 'm1.music.126.net') {
      const rangeHeader = request.headers.get('range') ?? ''; assert.match(rangeHeader, /^bytes=\d+-\d+(?:,\d+-\d+)*$/);
      const ranges = rangeHeader.slice(6).split(',').map(value => { const [start, end] = value.split('-').map(Number); return { start: start!, end: end! }; });
      if (ranges.length > 1) {
        const boundary = 'offline-worker-ranges';
        const chunks = ranges.flatMap(range => [`--${boundary}\r\nContent-Type: audio/mpeg\r\nContent-Range: bytes ${range.start}-${range.end}/${source.length}\r\n\r\n`,
          source.slice(range.start, range.end + 1), '\r\n']);
        const body = new Uint8Array(await new Blob([...chunks, `--${boundary}--\r\n`]).arrayBuffer());
        return new Response(body, { status: 206, headers: { 'content-length': String(body.length), 'content-type': `multipart/byteranges; boundary=${boundary}` } });
      }
      const { start, end } = ranges[0]!;
      return new Response(source.slice(start, end + 1), { status: 206, headers: { 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${source.length}` } });
    }
    if (url.hostname === 'p1.music.126.net') return new Response(picture, { headers: { 'content-type': 'image/png' } });
    assert(['music.163.com', 'interface.music.163.com'].includes(url.hostname), 'No real network fallback');
    if (path === '/api/login/qrcode/unikey') return Response.json({ code: 200, unikey: 'local-qr' });
    if (path === '/api/login/qrcode/client/login') return Response.json({ code: 803 }, { headers: { 'set-cookie': 'MUSIC_U=local-fixture; Domain=.music.163.com; Path=/; Expires=Thu, 31 Dec 2099 23:59:59 GMT; Secure' } });
    if (path === '/api/w/nuser/account/get') return Response.json({ code: 200, profile: { userId: 42, nickname: 'Offline' } });
    if (path === '/api/user/playlist') return Response.json({ code: 200, playlist: [{ id: 8, userId: 42, specialType: 5 }], more: false });
    if (path === '/api/v6/playlist/detail') return Response.json({ code: 200, playlist: { trackIds: ids.map(id => ({ id })), trackCount: ids.length, tracks: ids.slice(0, 10).map(song) } });
    if (path === '/api/song/detail/') return Response.json({ code: 200, songs: ids.map(richSong) });
    if (path === '/api/song/enhance/player/url/v1') {
      const data = encrypt.eapiReqDecrypt(new URLSearchParams(await request.text()).get('params')!)!.data;
      const selected = JSON.parse(String(data.ids)) as number[];
      return Response.json({ code: 200, data: selected.map(id => ({ id, level: data.level, type: 'mp3', url: `https://m1.music.126.net/${id}.mp3`, expi: 1200, md5: id.toString(16).padStart(32, '0'), size: source.length })) });
    }
    if (path.startsWith('/api/v1/album/')) return Response.json({ code: 200, album: { artist: { name: 'Artist' }, publishTime: 1577836800000, size: ids.length } });
    if (path === '/api/song/lyric/v1') return Response.json({ code: 200, lrc: { lyric: '[00:00.00]Lyrics' } });
    throw new Error(`Unhandled offline request: ${path}`);
  }, log: new Log(LogLevel.ERROR) });
try {
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()).replace(/^\s*--.*$/gm, '').replaceAll('\n', ' '));
  }
  const manifest = await Bun.file('plugins/netease/manifest.json').json();
  await db.prepare("INSERT INTO installations (id, manifest, revision, generation, status) VALUES (?, ?, ?, 1, 'active')").bind(manifest.id, JSON.stringify(manifest), 'f'.repeat(64)).run();
  const invoke = async <T>(path: string, body?: unknown): Promise<{ value: T; queries: number }> => {
    const response = await mf.dispatchFetch('http://probe' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer fixture-admin', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert(response.ok, `HTTP ${response.status} at ${path}: ${await response.clone().text()}`);
    return { value: await response.json() as T, queries: Number(response.headers.get('X-Probe-Queries')) };
  };
  const created = await invoke<{ value: { id: string } }>('/api/instances', { pluginId: manifest.id, name: 'Offline', config: {} });
  const base = `/api/instances/${created.value.value.id}`;
  const auth = await invoke<{ value: { operationId: string; step: { challengeId: string } } }>(`${base}/authentication`, { kind: 'start' });
  await invoke(`${base}/authentication`, { kind: 'poll', operationId: auth.value.value.operationId, challengeId: auth.value.value.step.challengeId });
  const mark = () => ({ requests, calls: { ...calls }, started: performance.now() });
  const cost = (before: ReturnType<typeof mark>) => ({ transportRequests: requests - before.requests,
    milliseconds: Math.round((performance.now() - before.started) * 10) / 10,
    calls: Object.fromEntries(Object.entries(calls).flatMap(([path, count]) => count === (before.calls[path] ?? 0) ? [] : [[path, count - (before.calls[path] ?? 0)]])) });
  const finish = async (initial: RefreshView) => {
    let job = initial; const queries: number[] = []; const stepMilliseconds: number[] = []; const before = mark();
    while (job.status === 'queued' || job.status === 'running') {
      const stepStarted = performance.now();
      const step = await invoke<RefreshView>(`/api/refreshes/${job.operationId}/step`, {}); job = step.value; queries.push(step.queries);
      stepMilliseconds.push(Math.round((performance.now() - stepStarted) * 10) / 10);
      assert(step.queries <= 50, `Free D1 query ceiling exceeded: ${step.queries}`); assert(queries.length < 100);
    }
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    return { job, metrics: { pages: job.current?.pages, queries, maxQueries: Math.max(...queries),
      stepMilliseconds: { min: Math.min(...stepMilliseconds), max: Math.max(...stepMilliseconds) }, ...cost(before) } };
  };
  const run = async (body: { directoryRef?: string } = { directoryRef: 'liked' }) => {
    const start = await invoke<RefreshView>(`${base}/refresh`, body); const completed = await finish(start.value);
    return { ...completed, metrics: { startQueries: start.queries, ...completed.metrics } };
  };
  const tagPlans = async () => (await db.prepare("SELECT count(*) AS count FROM source_plugin_cache WHERE cache_key LIKE 'reserved-plan:%'").first<{ count: number }>())!.count;
  type MusicFile = Extract<Entry, { kind: 'file' }>;
  const publishedFiles = async () => {
    const rows = await db.prepare(`SELECT e.document FROM library_snapshot_entries e JOIN directory_snapshots s ON s.published_attempt_id = e.attempt_id
      WHERE s.instance_id = ? AND s.kind = 'directory' AND s.ref = 'liked' ORDER BY e.ordinal`).bind(created.value.value.id).all<{ document: string }>();
    return rows.results.map(row => JSON.parse(row.document) as Entry).filter((entry): entry is MusicFile => entry.kind === 'file');
  };
  const cold = await run(); assert.equal(cold.metrics.pages, 1); assert.equal(cold.job.current?.progress?.completed, ids.length);
  const catalogueFiles = await publishedFiles(); assert.equal(catalogueFiles.length, ids.length);
  assert(catalogueFiles.every(file => file.info?.size === source.length + 1_048_576 && !file.deferredInfo));
  assert.equal(await tagPlans(), 0);
  assert(!Object.keys(cold.metrics.calls).some(path => /lyric|album|cover|[.]mp3/.test(path)));
  const catalogue = { ...cold.metrics, entries: catalogueFiles.length, pendingFileInfo: 0, tagPlans: 0 };

  // Resolve the real published path, including its roots snapshot, before exercising DAV.
  const rootsSetup = await run({});
  const roots = (await invoke<ContentSources>(`${base}/roots`)).value;
  const liked = roots.find(root => root.directoryRef === 'liked'); assert(liked);
  const path = `/Offline/${liked.name}`;
  const listing = await invoke<ViewEntry[]>(`/api/library?path=${encodeURIComponent(path)}`); assert.equal(listing.value.length, ids.length);
  const first = listing.value[0]!;
  const davPath = (path: string) => '/dav' + path.split('/').map(encodeURIComponent).join('/');
  const dav = (path: string, init: { method: 'GET' | 'HEAD' | 'PROPFIND'; headers?: Record<string, string>; body?: string }) => mf.dispatchFetch('http://probe' + davPath(path), { ...init,
    headers: { Authorization: 'Basic ' + btoa('reader:fixture'), ...init.headers } });
  const firstBefore = mark(); const firstHead = await dav(first.path, { method: 'HEAD' });
  assert.equal(firstHead.status, 200); assert.equal(await tagPlans(), 0);
  const firstCost = cost(firstBefore); assert.equal(firstCost.transportRequests, 0);
  const firstFile = { status: firstHead.status, queries: Number(firstHead.headers.get('X-Probe-Queries')), ...firstCost,
    preparedFiles: 0, contentLength: Number(firstHead.headers.get('Content-Length')), etag: firstHead.headers.get('ETag') };
  assert.equal(firstFile.contentLength, source.length + 1_048_576); assert(firstFile.etag);

  const allprop = '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>';
  const listBefore = mark(); const complete = await dav(path, { method: 'PROPFIND', headers: { Depth: '1' }, body: allprop });
  assert.equal(complete.status, 207); const xml = await complete.text();
  const lengths = Array.from(xml.matchAll(/<D:getcontentlength>(\d+)<\/D:getcontentlength>/g), match => Number(match[1]));
  assert.deepEqual(lengths, catalogueFiles.map(file => file.info!.size));
  const completeCost = cost(listBefore); assert.equal(completeCost.transportRequests, 0); assert.equal(await tagPlans(), 0);
  const listingProperties = { status: complete.status, queries: Number(complete.headers.get('X-Probe-Queries')),
    ...completeCost, exactFileProperties: lengths.length, preparedFiles: 0 };

  const reads: { queries: number; transportRequests: number; milliseconds: number; calls: Record<string, number> }[] = [];
  const openFile = async (range?: { start: number; end: number }) => {
    const before = mark();
    const response = await dav(first.path, { method: 'GET', ...(range ? { headers: { Range: `bytes=${range.start}-${range.end}`, 'If-Range': firstFile.etag! } } : {}) });
    assert.equal(response.status, range ? 206 : 200); assert.equal(response.headers.get('ETag'), firstFile.etag);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const queries = Number(response.headers.get('X-Probe-Queries')); assert(queries <= 50, `Free D1 query ceiling exceeded on GET: ${queries}`);
    reads.push({ queries, ...cost(before) }); return bytes;
  };
  const bytes = await openFile(); assert.equal(bytes.length, firstFile.contentLength); assert.equal(await tagPlans(), 1);
  const parsed = await parseBuffer(bytes, { mimeType: catalogueFiles[0]!.info!.mediaType });
  assert.equal(parsed.common.title, 'Song 1'); assert.deepEqual(parsed.common.picture?.[0]?.data, picture);
  const range = { start: bytes.length - 32, end: bytes.length - 1 }; assert.deepEqual(await openFile(range), bytes.slice(range.start));
  assert(!Object.keys(reads[0]!.calls).some(path => /^\/[2-9]\d*[.]mp3$/.test(path)));

  const warmRun = await run(); assert.equal(warmRun.metrics.pages, 1);
  const warmFiles = await publishedFiles(); assert.equal(warmFiles.length, ids.length);
  assert.equal(warmFiles[0]!.fileRef, catalogueFiles[0]!.fileRef); assert.deepEqual(warmFiles[0]!.info, catalogueFiles[0]!.info);
  assert(warmFiles.every(file => file.info?.size === source.length + 1_048_576)); assert.equal(await tagPlans(), 1);
  assert.equal(warmRun.metrics.transportRequests, 3);
  const warm = { ...warmRun.metrics, entries: warmFiles.length, pendingFileInfo: 0, reusedOpenedFile: true, tagPlans: 1 };
  const rows = await db.prepare("SELECT cache_key AS key, length(document) AS bytes FROM source_plugin_cache WHERE cache_key LIKE 'reserved-plan:%' OR cache_key LIKE 'tag-bytes:%'").all<{ key: string; bytes: number }>();
  const storage = { planBytes: rows.results.filter(row => row.key.startsWith('reserved-plan:')).reduce((n, row) => n + row.bytes, 0),
    sharedArtworkCount: rows.results.filter(row => row.key.startsWith('tag-bytes:')).length };
  assert.equal(storage.sharedArtworkCount, 1); assert(storage.planBytes < 8192);
  const report = { runtime: 'local workerd + D1, packed NetEase SDK, all outbound responses controlled',
    sqlAccounting: 'Application D1 statements per request; probe inspection queries excluded', tracks: ids.length,
    catalogue, firstFile, listingProperties, reads, warm, setup: { roots: rootsSetup.metrics, listingQueries: listing.queries }, storage,
    sharedPlanRead: { bytes: bytes.length, metadata: true, tailRange: true }, calls };
  const output = `.musicfs/refresh-evaluation/worker-reserved${tracks === 24 ? '' : '-200'}.json`;
  await Bun.write(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await mf.dispose(); await rm(root, { recursive: true, force: true }); }
