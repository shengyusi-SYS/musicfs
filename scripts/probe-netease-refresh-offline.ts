import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { buildNetease } from './build-netease';
import { workerCrypto } from './helpers/worker-crypto';
import { encrypt } from '../plugins/netease/generated-upstream.mjs';
import type { RefreshView } from '../src/contracts/refreshes';
import { cover } from '../packages/audio-tags/test-fixtures';
import { parseBuffer } from 'music-metadata';
import type { Entry } from '@musicfs/plugin-api';

await buildNetease();
const root = await mkdtemp(join(tmpdir(), 'musicfs-netease-refresh-'));
const source = new Uint8Array(await Bun.file('tests/fixtures/source-metadata/source.mp3').arrayBuffer());
const picture = new Uint8Array(32_768); picture.set(cover);
const ids = Array.from({ length: 24 }, (_, i) => i + 1);
const song = (id: number) => ({ id, name: `Song ${id}`, ar: [{ name: 'Artist' }], al: { id: 1, name: 'Album', picUrl: 'https://p1.music.126.net/cover.png' }, no: id, cd: '1' });
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
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('range') ?? ''); assert(match);
      const start = Number(match[1]); const end = Number(match[2]);
      return new Response(source.slice(start, end + 1), { status: 206, headers: { 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${source.length}` } });
    }
    if (url.hostname === 'p1.music.126.net') return new Response(picture, { headers: { 'content-type': 'image/png' } });
    assert(['music.163.com', 'interface.music.163.com'].includes(url.hostname), 'No real network fallback');
    if (path === '/api/login/qrcode/unikey') return Response.json({ code: 200, unikey: 'local-qr' });
    if (path === '/api/login/qrcode/client/login') return Response.json({ code: 803 }, { headers: { 'set-cookie': 'MUSIC_U=local-fixture; Domain=.music.163.com; Path=/; Expires=Thu, 31 Dec 2099 23:59:59 GMT; Secure' } });
    if (path === '/api/w/nuser/account/get') return Response.json({ code: 200, profile: { userId: 42, nickname: 'Offline' } });
    if (path === '/api/user/playlist') return Response.json({ code: 200, playlist: [{ id: 8, userId: 42, specialType: 5 }], more: false });
    if (path === '/api/v6/playlist/detail') return Response.json({ code: 200, playlist: { trackIds: ids.map(id => ({ id })), trackCount: ids.length, tracks: ids.slice(0, 10).map(song) } });
    if (path === '/api/v3/song/detail') return Response.json({ code: 200, songs: ids.map(song) });
    if (path === '/api/song/enhance/player/url/v1') {
      const data = encrypt.eapiReqDecrypt(new URLSearchParams(await request.text()).get('params')!)!.data;
      const selected = JSON.parse(String(data.ids)) as number[];
      return Response.json({ code: 200, data: selected.map(id => ({ id, level: data.level, type: 'mp3', url: `https://m1.music.126.net/${id}.mp3`, expi: 1200, md5: id.toString(16).padStart(32, '0'), size: source.length })) });
    }
    if (path.startsWith('/api/v1/album/')) return Response.json({ code: 200, album: { artist: { name: 'Artist' }, publishTime: 1577836800000, size: 24 } });
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
  const run = async () => {
    let job = (await invoke<RefreshView>(`${base}/refresh`, { directoryRef: 'liked' })).value;
    const queries: number[] = []; const before = requests;
    while (job.status === 'queued' || job.status === 'running') {
      const step = await invoke<RefreshView>(`/api/refreshes/${job.operationId}/step`, {}); job = step.value; queries.push(step.queries);
      assert(step.queries <= 50, `Free D1 query ceiling exceeded: ${step.queries}`); assert(queries.length < 100);
    }
    assert.equal(job.status, 'completed', JSON.stringify(job.error)); assert.equal(job.current?.progress?.completed, 24);
    return { pages: job.current?.pages, queries, maxQueries: Math.max(...queries), transportRequests: requests - before };
  };
  const cold = await run(); const warm = await run(); assert.equal(warm.pages, 1);
  const rows = await db.prepare("SELECT cache_key AS key, length(document) AS bytes FROM source_plugin_cache WHERE cache_key LIKE 'tag-plan:%' OR cache_key LIKE 'tag-bytes:%'").all<{ key: string; bytes: number }>();
  const storage = { planBytes: rows.results.filter(row => row.key.startsWith('tag-plan:')).reduce((n, row) => n + row.bytes, 0),
    sharedArtworkCount: rows.results.filter(row => row.key.startsWith('tag-bytes:')).length };
  assert.equal(storage.sharedArtworkCount, 1); assert(storage.planBytes < 24 * 8192);
  const row = await db.prepare("SELECT document FROM library_snapshot_entries ORDER BY ordinal LIMIT 1").first<{ document: string }>();
  const file = JSON.parse(row!.document) as Extract<Entry, { kind: 'file' }>; assert(file.info);
  const openFile = async (range?: { start: number; end: number }) => {
    const response = await mf.dispatchFetch('http://probe/__open', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: created.value.value.id, fileRef: file.fileRef, info: file.info, ...(range ? { range } : {}) }) });
    assert.equal(response.status, 200); return new Uint8Array(await response.arrayBuffer());
  };
  const bytes = await openFile(); assert.equal(bytes.length, file.info.size);
  const parsed = await parseBuffer(bytes, { mimeType: file.info.mediaType });
  assert.equal(parsed.common.title, 'Song 1'); assert.deepEqual(parsed.common.picture?.[0]?.data, picture);
  const range = { start: bytes.length - 32, end: bytes.length - 1 }; assert.deepEqual(await openFile(range), bytes.slice(range.start));
  const report = { runtime: 'local workerd + D1, packed NetEase SDK, all outbound responses controlled', tracks: 24, cold, warm, storage,
    sharedPlanRead: { bytes: bytes.length, metadata: true, tailRange: true }, calls };
  const output = '.musicfs/refresh-evaluation/worker.json'; await Bun.write(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await mf.dispose(); await rm(root, { recursive: true, force: true }); }
