import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { parseBuffer } from 'music-metadata';
import type { TaggedPlan } from '../../packages/audio-tags/src';
import { segmentSize } from '../../packages/audio-tags/src/bytes';
import { audioTagBuildOptions } from '../build-plugin';
import { requestReady } from '../helpers/refresh-http';

const source = new Uint8Array(await Bun.file('tests/fixtures/source-metadata/source.m4a').arrayBuffer());
const cover = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=', 'base64');
const directory = await mkdtemp(join(tmpdir(), 'musicfs-worker-metadata-'));
let outbound = 0;
// Run after building current example bundles; only their configurations are read.
await cp('dist/plugins/org.musicfs.qq/index.mjs', join(directory, 'qq.mjs')); await cp('dist/netease/org.musicfs.netease/index.mjs', join(directory, 'netease.mjs'));
const build = await Bun.build({ ...audioTagBuildOptions, entrypoints: ['tests/probes/worker-audio-metadata.ts'], target: 'browser', format: 'esm', outdir: directory, naming: 'worker.mjs',
  plugins: [{ name: 'external-example-bundles', setup(builder) { builder.onResolve({ filter: /^musicfs-(qq|netease)-artifact$/ }, args => ({ path: `./${args.path.includes('netease') ? 'netease' : 'qq'}.mjs`, external: true })); } }] });
if (!build.success) { await rm(directory, { recursive: true, force: true }); throw new AggregateError(build.logs, 'Audio metadata Worker probe build failed'); }
const start = () => new Miniflare({ modulesRoot: directory, modules: ['worker.mjs', 'qq.mjs', 'netease.mjs'].map(name => ({ type: 'ESModule' as const, path: join(directory, name) })),
  compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'metadata' }, d1Persist: join(directory, 'd1'),
  bindings: { SOURCE: Buffer.from(source).toString('base64'), COVER: cover.toString('base64') },
  outboundService: () => { outbound++; throw new Error('External HTTP is forbidden in this offline probe'); }, log: new Log(LogLevel.ERROR) });
let mf = start();
const auth = { Authorization: 'Basic ' + Buffer.from('reader:fixture-password').toString('base64') };
const admin = { Authorization: 'Bearer fixture-admin' };
const file = 'http://probe/dav/Metadata/Audio/Tagged.m4a';
const dispatch = (url: string, init?: Pick<RequestInit, 'method' | 'headers'>) => mf.dispatchFetch(url, { ...init, headers: Object.fromEntries(new Headers(init?.headers)) });
try {
  const examples = await (await dispatch('http://probe/__examples')).json() as Record<string, { schema: { type?: string } }>;
  assert.equal(examples.qq?.schema.type, 'object'); assert.equal(examples.netease?.schema.type, 'object');
  let db = await mf.getD1Database('DB');
  for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()).replace(/^\s*--.*$/gm, '').replaceAll('\n', ' '));
  }
  const manifest = { formatVersion: 1, id: 'org.musicfs.test.metadata', name: 'Synthetic metadata', version: '0.1.0', apiRange: '>=0.1.6 <0.2.0',
    hosts: { worker: 'index.mjs' }, configVersion: 1, stateVersion: 1, files: ['index.mjs'] };
  await db.prepare("INSERT INTO installations (id, manifest, revision, generation, status) VALUES (?, ?, ?, 1, 'active')").bind(manifest.id, JSON.stringify(manifest), 'a'.repeat(64)).run();
  await db.prepare('INSERT INTO instances (id, plugin_id, name, config, private_state, epoch, state_revision) VALUES (?, ?, ?, ?, ?, 1, 1)').bind('metadata', manifest.id, 'Metadata', '{}', 'null').run();
  const listing = await requestReady(dispatch, 'http://probe/dav/Metadata/Audio/', { method: 'PROPFIND', headers: { ...auth, Depth: '1' } }, admin);
  assert.equal(listing.status, 207); assert((await listing.text()).includes('Tagged.m4a'));
  const row = await db.prepare("SELECT document FROM source_plugin_cache WHERE instance_id='metadata' AND cache_key='tag-plan'").first<{ document: string }>();
  assert(row); const plan = JSON.parse(row.document) as TaggedPlan;
  const head = await dispatch(file, { method: 'HEAD', headers: auth }); assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), String(plan.content.size)); assert.equal(head.headers.get('Content-Type'), 'audio/mp4');
  const full = await dispatch(file, { headers: auth }); assert.equal(full.status, 200); const bytes = new Uint8Array(await full.arrayBuffer()); assert.equal(bytes.length, plan.content.size);
  const parsed = (await parseBuffer(bytes, { mimeType: 'audio/mp4', size: bytes.length })).common;
  assert.equal(parsed.title, 'Worker song'); assert.deepEqual(parsed.artists, ['Artist A', 'Artist B']); assert.equal(parsed.album, 'Fixture album');
  assert.deepEqual(parsed.albumartists, ['Album artist']); assert.equal(parsed.date, '2026-10-21'); assert.deepEqual(parsed.track, { no: 3, of: 12 }); assert.deepEqual(parsed.disk, { no: 2, of: 2 });
  assert.deepEqual(parsed.picture?.[0]?.data, new Uint8Array(cover)); assert.deepEqual(parsed.lyrics?.[0]?.syncText, [{ timestamp: 0, text: 'Original' }, { timestamp: 500, text: 'Second line' }]);
  assert(Buffer.from(bytes).includes(Buffer.from('Translation'))); assert(Buffer.from(bytes).includes(Buffer.from('Romanization')));
  let boundary = 0; let offset = 0;
  for (const segment of plan.segments) { if (segment.kind === 'bytes' && offset > 0) boundary = offset; offset += segmentSize(segment); }
  assert(boundary > 8 && boundary < bytes.length - 8, 'The range must cross source and rewritten metadata');
  for (const [range, start, end] of [[`bytes=${boundary - 8}-${boundary + 7}`, boundary - 8, boundary + 7], ['bytes=-32', bytes.length - 32, bytes.length - 1]] as const) {
    const response = await dispatch(file, { headers: { ...auth, Range: range } }); assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/${bytes.length}`); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(start, end + 1));
  }
  const initial = await (await dispatch('http://probe/__probe')).json() as { prepares: number }; assert.equal(initial.prepares, 1);
  await mf.dispose(); mf = start(); db = await mf.getD1Database('DB');
  const restored = await dispatch(file, { headers: auth }); assert.equal(restored.status, 200); assert.equal(restored.headers.get('ETag'), full.headers.get('ETag'));
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), bytes);
  const after = await (await dispatch('http://probe/__probe')).json() as { prepares: number; cacheReads: number };
  assert.equal(after.prepares, 0); assert(after.cacheReads > 0); assert.equal(await db.prepare("SELECT document FROM source_plugin_cache WHERE cache_key='tag-plan'").first('document'), row.document); assert.equal(outbound, 0);
  console.log(JSON.stringify({ runtime: 'local workerd', format: 'm4a', sourceBytes: source.length, taggedBytes: bytes.length, propfind: 207,
    metadata: 'fields/cover/timed lyrics/translation/romanization', ranges: 'metadata-boundary/tail', persistedPlan: true, restartPrepares: after.prepares, exampleConfigurations: ['qq', 'netease'], outbound }));
} finally { try { await mf.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } }
