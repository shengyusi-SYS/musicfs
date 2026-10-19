import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { Database } from 'bun:sqlite';
import type { Context, SourcePlugin } from '@musicfs/plugin-api';
import { buildNetease } from './build-netease';
import { completeRefresh, publishedDirectory, requestReady } from './helpers/refresh-http';

await buildNetease();
const desktopPlugin = (await import(pathToFileURL(resolve('dist/netease/org.musicfs.netease/index.mjs')).href) as { default: SourcePlugin }).default;
const desktopContext: Context = { instanceId: 'native-probe', config: {}, privateState: null, signal: new AbortController().signal, fetch };
const desktopStart = await desktopPlugin.authenticate!(desktopContext, { kind: 'start' });
assert(desktopStart.ok, desktopStart.ok ? '' : desktopStart.error.message);
assert.equal(desktopStart.value.kind, 'waiting');
console.log(JSON.stringify({ runtime: 'Bun', packedBundle: true, upstreamQrCreated: true, realLoginTested: false }));
const build = await Bun.build({ entrypoints: ['tests/probes/worker-netease.ts'], target: 'browser', format: 'esm', outdir: 'dist/netease/worker', naming: 'worker.mjs',
  external: ['node:crypto', 'node:zlib'],
  plugins: [{ name: 'packed-netease-artifact', setup(builder) {
    builder.onResolve({ filter: /^musicfs-netease-artifact$/ }, () => ({ path: resolve('dist/netease/org.musicfs.netease/index.mjs') }));
    builder.onResolve({ filter: /^node:(crypto|zlib)$/ }, args => ({ path: args.path, external: true }));
  } }] });
if (!build.success) throw new AggregateError(build.logs, 'NetEase Worker probe build failed');
const directory = await mkdtemp(join(tmpdir(), 'musicfs-worker-netease-'));
const mf = new Miniflare({ modules: [{ type: 'ESModule', path: resolve('dist/netease/worker/worker.mjs') }], compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'musicfs-netease-p0' }, d1Persist: directory, log: new Log(LogLevel.ERROR) });
try {
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir('src/infrastructure/persistence/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec((await Bun.file(`src/infrastructure/persistence/migrations/${name}`).text()).replace(/^\s*--.*$/gm, '').replaceAll('\n', ' '));
  }
  const headers = { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' };
  const dispatch = (url: string, init?: Pick<RequestInit, 'method' | 'headers'>) => mf.dispatchFetch(url, { ...init, headers: Object.fromEntries(new Headers(init?.headers)) });
  const ids: string[] = [];
  for (const name of ['网易云甲', '网易云乙']) {
    const created = await mf.dispatchFetch('http://probe/api/instances', { method: 'POST', headers, body: JSON.stringify({ pluginId: 'org.musicfs.netease', name, config: {} }) });
    assert.equal(created.status, 201); const text = await created.text(); assert(!text.includes('cookies')); assert(!text.includes('privateState'));
    ids.push((JSON.parse(text) as { value: { id: string } }).value.id);
  }
  const states = await db.prepare('SELECT private_state FROM instances ORDER BY rowid').all<{ private_state: string }>();
  assert.equal(states.results.length, 2); assert.notEqual(states.results[0]!.private_state, states.results[1]!.private_state);
  const start = await mf.dispatchFetch(`http://probe/api/instances/${ids[0]}/authentication`, { method: 'POST', headers, body: JSON.stringify({ kind: 'start' }) });
  const initial = await start.json() as unknown;
  assert.equal(start.status, 200, JSON.stringify(initial));
  const qr = (initial as { value: { step: { kind: string; qrCode?: string } } }).value.step;
  assert.equal(qr.kind, 'waiting'); assert(qr.qrCode?.startsWith('https://music.163.com/login?codekey='));
  let restoredRealSession = false;
  const { MUSICFS_NETEASE_TEST_STATE_DB, MUSICFS_NETEASE_TEST_INSTANCE_ID } = process.env;
  if (MUSICFS_NETEASE_TEST_STATE_DB || MUSICFS_NETEASE_TEST_INSTANCE_ID) {
    assert(MUSICFS_NETEASE_TEST_STATE_DB && MUSICFS_NETEASE_TEST_INSTANCE_ID, 'Set both real-session probe selectors');
    const desktop = new Database(MUSICFS_NETEASE_TEST_STATE_DB, { readonly: true }); let selected: { private_state: string; config: string } | null;
    try { selected = desktop.query('SELECT private_state, config FROM instances WHERE id = ? AND plugin_id = ?').get(MUSICFS_NETEASE_TEST_INSTANCE_ID, 'org.musicfs.netease') as typeof selected; }
    finally { desktop.close(); }
    assert(selected && JSON.parse(selected.private_state).accountId, 'The selected instance must already be authorized');
    await db.prepare('UPDATE instances SET private_state = ?, config = ? WHERE id = ?').bind(selected.private_state, selected.config, ids[1]!).run();
    const roots = await requestReady(dispatch, `http://probe/api/instances/${ids[1]}/roots`, { headers }); assert.equal(roots.status, 200); assert.equal((await roots.json() as unknown[]).length, 5);
    const content = await mf.dispatchFetch(`http://probe/api/instances/${ids[1]}/refresh`, { method: 'POST', headers, body: JSON.stringify({ directoryRef: 'daily' }) });
    await completeRefresh(dispatch, content, 'http://probe', headers);
    const page = await publishedDirectory(dispatch, 'http://probe', ids[1]!, 'daily', headers);
    console.log(JSON.stringify({ runtime: 'local workerd', realDailyFiles: page.entries.length, statistics: page.status?.statistics }));
    restoredRealSession = true;
  }
  console.log(JSON.stringify({ runtime: 'local workerd', sdk: 'NeteaseCloudMusicApi 4.32.0', packedBundle: true, nodeCompatibility: true, isolatedCookieJars: true,
    standaloneValidation: true, upstreamQrCreated: true, restoredRealSession, realLoginTested: false, cloudDeploymentTested: false }));
} finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
