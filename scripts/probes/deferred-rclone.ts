import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Entry, SourcePlugin } from '@musicfs/plugin-api';
import { parseManifest, type PluginRegistry } from '../../src/core/extensions';
import { createLibrary, type RefreshView } from '../../src/core/library';
import { createSources } from '../../src/core/sources';
import { openSqlite } from '../../src/infrastructure/persistence/sqlite';
import { createDav } from '../../src/transport/dav';
import rawManifest from '../../plugins/sample/manifest.json';

// Local synthetic bytes only: no desktop/Worker host, platform API, or downloads.
const binary = resolve('dist/tools/rclone-v1.75.2-linux-amd64/rclone');
assert(await Bun.file(binary).exists(), `Missing existing rclone binary: ${binary}`);
const directory = await mkdtemp(join(tmpdir(), 'musicfs-deferred-rclone-'));
const bytes = new TextEncoder().encode('ABCDEFGH');
const names = Array.from({ length: 6 }, (_, index) => `${index}.wav`);
const libraryPath = '/实例 & #/来源';
const davPath = '/dav' + libraryPath.split('/').map(encodeURIComponent).join('/');
const authorization = 'Basic ' + btoa('reader:fixture-password');
const signal = () => new AbortController().signal;
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const round = (value: number) => Math.round(value * 10) / 10;

async function execute(args: string[], env = process.env, stdin?: Uint8Array) {
  const started = performance.now();
  const child = Bun.spawn([binary, ...args], { env, ...(stdin ? { stdin } : {}), stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).bytes(), new Response(child.stderr).text()]);
    return { code, stdout, stderr, milliseconds: round(performance.now() - started) };
  } finally { clearTimeout(timeout); }
}

async function fixture(label: string, automatic: boolean) {
  const databasePath = join(directory, `${label}.sqlite`);
  let store = openSqlite(databasePath);
  const stats: string[] = [];
  const preparationPages: number[] = [];
  const requests: { method: string; path: string; status: number; range: string | null }[] = [];
  const info = (file: string) => ({ contentId: file, size: bytes.length, mediaType: 'audio/wav', modifiedAt: '2026-10-20T00:00:00.000Z' });
  const plugin: SourcePlugin = {
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, value) => ({ ok: true, value }),
    roots: async () => ({ ok: true, value: { items: [{ sourceId: 'root', name: '来源', directoryRef: 'root' }] } }),
    list: async (ctx, ref, cursor) => {
      assert.equal(ref, 'root');
      const offset = Number(cursor ?? 0);
      const required = ctx.fileInfo === 'required';
      const end = required ? Math.min(offset + 2, names.length) : names.length;
      if (required) preparationPages.push(offset);
      const items: Entry[] = names.slice(offset, end).map(file => ({ kind: 'file', entryId: file, name: file, fileRef: file,
        deferredInfo: true, ...(required ? { info: info(file) } : {}) }));
      return { ok: true, value: { items, ...(end < names.length ? { nextCursor: String(end) } : {}) } };
    },
    stat: async (_ctx, file) => { stats.push(file); return { ok: true, value: info(file) }; },
    open: async (_ctx, file, request) => {
      assert(names.includes(file)); assert.equal(request.expectedContentId, file);
      const body = request.range ? bytes.slice(request.range.start, request.range.end + 1) : bytes;
      return { ok: true, value: { content: info(file), servedRange: request.range ?? null, body: new Blob([body]).stream() } };
    }
  };
  store.activate(parseManifest(rawManifest, 'desktop'), 'a'.repeat(64), null);
  const registry: PluginRegistry = {
    async get(id) {
      const installed = store.installation(id); assert(installed?.status === 'active');
      return { ...installed, module: plugin };
    },
    async isCurrent(id, revision, generation) {
      const installed = store.installation(id);
      return installed?.status === 'active' && installed.revision === revision && installed.generation === generation;
    }
  };
  let sources = createSources(store, registry);
  const created = await sources.create(rawManifest.id, '实例 & #', {}, signal()); assert(created.ok);
  const id = created.value.id;
  const initial = createLibrary(sources, store);
  await initial.contentSources(id, signal()); await initial.refresh(id, 'root', signal());
  let library = createLibrary(sources, store, undefined, { execution: 'deferred' });
  let app = createDav(library.files, { username: 'reader', password: 'fixture-password' });
  let background: Promise<{ steps: number; milliseconds: number }> | undefined;
  let backgroundError: unknown;
  const snapshot = () => {
    const value = store.snapshot(id, { kind: 'directory', ref: 'root' })?.value;
    assert(value?.kind === 'directory'); return value;
  };
  assert.equal(snapshot().pendingFileInfo, names.length);
  const finish = async (operationId: string) => {
    const started = performance.now(); let steps = 0;
    let state = await library.refreshes.get(operationId); assert(state);
    while (state.status === 'queued' || state.status === 'running') {
      assert(++steps <= 10, 'Preparation did not finish within the small fixture budget');
      state = await library.refreshes.step(operationId, signal());
    }
    assert.equal(state.status, 'completed', JSON.stringify(state));
    assert.equal(snapshot().pendingFileInfo ?? 0, 0);
    assert(snapshot().items.every(entry => entry.kind === 'file' && entry.info?.size === bytes.length));
    return { steps, milliseconds: round(performance.now() - started) };
  };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const response = await app.fetch(request);
    requests.push({ method: request.method, path: new URL(request.url).pathname.replace(/\/$/, ''), status: response.status, range: request.headers.get('Range') });
    if (automatic && response.status === 503 && !background) {
      const operationId = response.headers.get('X-MusicFS-Refresh'); assert(operationId);
      // The probe schedules existing background steps independently of the DAV response.
      background = (async () => { await Bun.sleep(50); return finish(operationId); })();
      void background.catch(error => { backgroundError = error; });
    }
    return response;
  } });
  return {
    stats, preparationPages, requests, server, snapshot, finish,
    get library() { return library; },
    get background() { return background; },
    get backgroundError() { return backgroundError; },
    reopen() {
      store.close(); store = openSqlite(databasePath); sources = createSources(store, registry);
      library = createLibrary(sources, store, undefined, { execution: 'deferred' });
      app = createDav(library.files, { username: 'reader', password: 'fixture-password' });
    },
    async close() { await server.stop(true); await background?.catch(() => {}); store.close(); }
  };
}

try {
  const version = await execute(['version']); assert.equal(version.code, 0, version.stderr);
  const client = decode(version.stdout).split('\n')[0]; assert.equal(client, 'rclone v1.75.2');
  const password = await execute(['obscure', '-'], process.env, new TextEncoder().encode('fixture-password\n'));
  assert.equal(password.code, 0, password.stderr);
  const config = join(directory, 'rclone.conf'); await Bun.write(config, '');
  const flags = ['--config', config, '--log-level', 'ERROR', '--timeout', '10s', '--retries', '1'];
  const envFor = (url: URL) => ({ ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost',
    RCLONE_CONFIG_PROBE_TYPE: 'webdav', RCLONE_CONFIG_PROBE_URL: new URL('/dav/', url).href,
    RCLONE_CONFIG_PROBE_VENDOR: 'other', RCLONE_CONFIG_PROBE_USER: 'reader', RCLONE_CONFIG_PROBE_PASS: decode(password.stdout).trim() });
  const listing = ['lsjson', 'probe:', '-R', '--files-only'];
  const verifyListing = (result: Awaited<ReturnType<typeof execute>>) => {
    assert.equal(result.code, 0, result.stderr);
    const files = JSON.parse(decode(result.stdout)) as { Path: string; Size: number; IsDir: boolean }[];
    assert.deepEqual(files.map(file => file.Path).sort(), names.map(name => `${libraryPath.slice(1)}/${name}`).sort());
    assert(files.every(file => file.Size === bytes.length && file.IsDir === false));
    return files;
  };

  const f = await fixture('manual', false);
  let manual;
  try {
    const started = performance.now();
    const pending = await fetch(new URL(davPath, f.server.url), { method: 'PROPFIND', headers: { Authorization: authorization, Depth: '1' },
      body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>' });
    const milliseconds = round(performance.now() - started);
    assert.equal(pending.status, 503); assert.equal(pending.headers.get('Retry-After'), '2');
    const operationId = pending.headers.get('X-MusicFS-Refresh'); assert(operationId); await pending.body?.cancel();
    assert.deepEqual(f.stats, []); assert.deepEqual(f.preparationPages, []);
    const queued = await f.library.refreshes.get(operationId); assert(queued);
    assert.deepEqual(queued.scope, { kind: 'file-info', directoryRef: 'root' }); assert.equal(queued.status, 'queued');
    f.reopen(); assert.deepEqual(await f.library.refreshes.get(operationId), queued);
    const env = envFor(f.server.url);
    const coldStart = f.requests.length;
    const cold = await execute([...listing, ...flags, '--low-level-retries', '1'], env);
    assert.notEqual(cold.code, 0, 'An unprepared directory must not produce an incomplete successful scan');
    assert.match(cold.stderr, /503/);
    assert(f.requests.slice(coldStart).some(request => request.status === 503 && request.path === davPath));
    assert.deepEqual(f.stats, []); assert.deepEqual(f.preparationPages, []);
    const baseline = f.snapshot().id;
    const first: RefreshView = await f.library.refreshes.step(operationId, signal());
    assert.equal(first.status, 'running'); assert.equal(f.snapshot().id, baseline);
    assert.equal((await f.library.files.list(libraryPath, signal())).length, names.length);
    const preparation = await f.finish(operationId); assert.deepEqual(f.preparationPages, [0, 2, 4]);
    const files = verifyListing(await execute([...listing, ...flags, '--low-level-retries', '1'], env));
    const remote = 'probe:' + files[0]!.Path;
    const full = await execute(['cat', remote, ...flags, '--low-level-retries', '1'], env);
    assert.equal(full.code, 0, full.stderr); assert.deepEqual(full.stdout, bytes);
    const rangeStart = f.requests.length;
    for (const [offset, count] of [[0, 2], [2, 2], [6, 2], [2, 2]] as const) {
      const part = await execute(['cat', remote, '--offset', String(offset), '--count', String(count), ...flags, '--low-level-retries', '1'], env);
      assert.equal(part.code, 0, part.stderr); assert.deepEqual(part.stdout, bytes.slice(offset, offset + count));
    }
    const ranges = f.requests.slice(rangeStart).filter(request => request.method === 'GET');
    assert.equal(ranges.length, 4); assert(ranges.every(request => request.status === 206 && request.range));
    assert.deepEqual(f.stats, []);
    manual = { firstAllprop: { status: pending.status, retryAfter: pending.headers.get('Retry-After'), milliseconds,
      synchronousStatCalls: 0, synchronousPreparationPages: 0, queued: true, survivedSqliteReopen: true },
      unpreparedRclone: { exitCode: cold.code, lowLevelRetries: 1 },
      preparation: { steps: preparation.steps + 1, pages: f.preparationPages.length, statCalls: f.stats.length, partialSnapshotStayedPublished: true },
      preparedRclone: { files: files.length, sizes: files.map(file => file.Size), fullRead: true,
        ranges: ranges.map(request => ({ range: request.range, status: request.status })) } };
  } finally { await f.close(); }

  const retry = await fixture('retry', true);
  let automaticRetry;
  try {
    const result = await execute([...listing, ...flags, '--low-level-retries', '3'], envFor(retry.server.url));
    const preparation = await retry.background;
    if (retry.backgroundError) throw retry.backgroundError;
    assert(preparation, 'Cold rclone scan did not trigger background preparation');
    const pendingResponses = retry.requests.filter(request => request.status === 503).length;
    // Scheduling can change whether this small fixture fits within the client's finite retries.
    if (result.code === 0) verifyListing(result);
    else assert.match(result.stderr, /503/);
    const files = verifyListing(await execute([...listing, ...flags, '--low-level-retries', '1'], envFor(retry.server.url)));
    assert(retry.requests.some(request => request.status === 503 && request.path === davPath));
    assert(retry.requests.some(request => request.status === 207 && request.path === davPath));
    assert.deepEqual(retry.preparationPages, [0, 2, 4]); assert.deepEqual(retry.stats, []);
    automaticRetry = { files: files.length, lowLevelRetries: 3, highLevelRetries: 1, milliseconds: result.milliseconds,
      exitCode: result.code, pendingResponses, backgroundSteps: preparation.steps, preparationMilliseconds: preparation.milliseconds,
      completedWithinFiniteRetries: result.code === 0, scanAfterPreparationSucceeded: true };
  } finally { await retry.close(); }

  const report = { client, runtime: 'loopback Bun + createLibrary/createDav + on-disk SQLite + offline SourcePlugin',
    tracks: names.length, bytesPerTrack: bytes.length, ...manual, shortFixtureAutomaticRetry: automaticRetry,
    limits: ['Large libraries should prepare file properties in the UI before third-party scans.',
      'This short fixture proves only these bounded rclone retries; clients are not guaranteed to wait automatically.',
      'No mount, real platform, desktop/Worker host, cloud, or new download was exercised.'] };
  await Bun.write('.musicfs/refresh-evaluation/rclone-deferred.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await rm(directory, { recursive: true, force: true }); }
