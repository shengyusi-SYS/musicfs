import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildPlugin } from './build-plugin';
import { requestReady } from './helpers/refresh-http';

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { output: { type: 'string' } } });
const root = await mkdtemp(join(tmpdir(), 'musicfs-stream-resources-'));
const entries = 4657; const pageSize = 200; const chunkSize = 64 * 1024; const bytesPerSecond = 8 * 1024 ** 2;
const admin = { Authorization: 'Bearer resource-fixture-admin' };
const reader = { Authorization: 'Basic ' + Buffer.from('reader:resource-fixture-reader').toString('base64') };
let catalogRequests = 0; let generatedBytes = 0; let streams = 0; let active = 0; let maxActive = 0;
const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/catalog') {
    catalogRequests++; const offset = Number(url.searchParams.get('offset')); const size = Number(url.searchParams.get('size'));
    const end = Math.min(entries, offset + pageSize);
    return Response.json({ items: Array.from({ length: end - offset }, (_, n) => ({ kind: 'file', entryId: `entry-${offset + n}`,
      name: `file-${offset + n}.bin`, fileRef: String(size), info: { contentId: `resource-fixture-${size}`, size, mediaType: 'application/octet-stream' } })),
      ...(end < entries ? { nextCursor: String(end) } : {}) });
  }
  const size = Number(url.pathname.slice('/bytes/'.length));
  if (!url.pathname.startsWith('/bytes/') || !Number.isSafeInteger(size) || size < 1) return new Response(null, { status: 404 });
  streams++; active++; maxActive = Math.max(maxActive, active); let sent = 0; let ended = false;
  const finish = () => { if (!ended) { ended = true; active--; } };
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === size) { finish(); controller.close(); return; }
      const length = Math.min(chunkSize, size - sent); sent += length; generatedBytes += length;
      controller.enqueue(new Uint8Array(length).fill(0x5a));
    }, cancel: finish
  }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) } });
} });
type Memory = { rss: number; heapUsed: number; external: number; arrayBuffers: number };
type Measurement = { baseline: Memory; after: Memory; sampledPeak: Memory; samples: number; sampleIntervalMs: number; elapsedMs: number; processCpuMs: number };
const results: unknown[] = [];
try {
  const pluginDirectory = join(root, 'plugin'); await mkdir(pluginDirectory);
  await cp('tests/fixtures/resource-plugin.ts', join(pluginDirectory, 'index.ts')); await cp('LICENSE', join(pluginDirectory, 'LICENSE.txt'));
  await Bun.write(join(pluginDirectory, 'manifest.json'), JSON.stringify({ formatVersion: 1, id: 'org.musicfs.test.resources', name: 'Resource measurement fixture', version: '0.1.0',
    apiRange: '>=0.1.0 <0.2.0', hosts: { desktop: 'index.mjs' }, configVersion: 1, stateVersion: 1, files: ['index.mjs', 'LICENSE.txt'] }));
  const archive = await buildPlugin(pluginDirectory, join(root, 'plugin.zip'));
  for (const [sizeMiB, concurrency] of [[32, 1], [256, 1], [256, 4]] as const) {
    const directory = join(root, `${sizeMiB}-${concurrency}`); await mkdir(directory);
    const child = Bun.spawn([process.execPath, resolve('tests/probes/desktop-resources.ts'), directory], { stdout: 'ignore', stderr: 'pipe' });
    try {
      while (!await Bun.file(join(directory, 'ready.json')).exists()) {
        if (child.exitCode !== null) throw new Error(`Resource service exited before readiness: ${await new Response(child.stderr).text()}`);
        await Bun.sleep(25);
      }
      const { origin } = await Bun.file(join(directory, 'ready.json')).json() as { origin: string };
      const installed = await fetch(origin + '/api/plugins', { method: 'POST', headers: admin, body: new Uint8Array(archive).buffer });
      assert.equal(installed.status, 201); await installed.body?.cancel();
      const size = sizeMiB * 1024 ** 2;
      const created = await fetch(origin + '/api/instances', { method: 'POST', headers: { ...admin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId: 'org.musicfs.test.resources', name: 'Resource fixture', config: { upstream: upstream.url.origin, size } }) });
      assert.equal(created.status, 201); await created.body?.cancel();
      catalogRequests = 0; generatedBytes = 0; streams = 0; maxActive = 0;
      const listingUrl = origin + '/dav/Resource%20fixture/Files/'; const listingOptions = { method: 'PROPFIND', headers: { ...reader, Depth: '1' } };
      let pendingReads = 0;
      const dispatch = async (input: string, init?: Pick<RequestInit, 'method' | 'headers'>) => {
        const response = await fetch(input, init); if (response.status === 503) pendingReads++; return response;
      };
      const coldStart = performance.now(); const cold = await requestReady(dispatch, listingUrl, listingOptions, admin);
      assert.equal(cold.status, 207); const xml = await cold.text(); const coldMs = performance.now() - coldStart;
      assert.equal((xml.match(/<D:response>/g) ?? []).length, entries + 1); assert.equal(catalogRequests, Math.ceil(entries / pageSize));
      const coldRequests = catalogRequests; const warmStart = performance.now();
      const warm = await fetch(listingUrl, listingOptions); assert.equal(warm.status, 207); assert.equal(await warm.text(), xml);
      const warmMs = performance.now() - warmStart; assert.equal(catalogRequests, coldRequests);
      const head = await fetch(listingUrl + 'file-0.bin', { method: 'HEAD', headers: reader });
      assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), String(size));
      await (await fetch(origin + '/__resource/start', { method: 'POST', headers: admin })).body?.cancel();
      const start = performance.now(); const firstBytes: { elapsedMs: number; upstreamBytesGenerated: number }[] = [];
      const framing: { contentLength: string | null; transferEncoding: string | null }[] = [];
      const received = await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
        const response = await fetch(listingUrl + `file-${index}.bin`, { headers: reader, signal: AbortSignal.timeout(90_000) });
        assert.equal(response.status, 200);
        const contentLength = response.headers.get('Content-Length');
        if (contentLength !== null) assert.equal(contentLength, String(size));
        framing.push({ contentLength, transferEncoding: response.headers.get('Transfer-Encoding') });
        assert(response.body); const body = response.body.getReader(); let total = 0;
        for (;;) {
          const next = await body.read(); if (next.done) break;
          if (total === 0) firstBytes.push({ elapsedMs: performance.now() - start, upstreamBytesGenerated: generatedBytes });
          assert(next.value.length > 0); assert.equal(next.value[0], 0x5a); assert.equal(next.value.at(-1), 0x5a);
          total += next.value.byteLength;
          await Bun.sleep(next.value.byteLength * 1000 / bytesPerSecond);
        }
        assert.equal(total, size); return total;
      }));
      const elapsedMs = performance.now() - start;
      const memory = await (await fetch(origin + '/__resource/end', { headers: admin })).json() as Measurement;
      assert.equal(streams, concurrency); assert.equal(maxActive, concurrency); assert.equal(generatedBytes, size * concurrency); assert.equal(active, 0);
      assert(firstBytes[0]!.upstreamBytesGenerated < size * concurrency, 'No client bytes arrived until the upstream finished');
      const result = { sizeMiB, concurrency, totalReceivedBytes: received.reduce((a, b) => a + b, 0), elapsedMs, firstBytes, framing,
        upstreamStreams: streams, maxActiveUpstreamStreams: maxActive,
        directory: { entries, pages: coldRequests, coldUntilReadyMs: coldMs, pendingReads, warmMs, warmCatalogRequests: catalogRequests - coldRequests, xmlBytes: Buffer.byteLength(xml) }, memory };
      results.push(result); console.log(JSON.stringify(result));
    } finally { child.kill('SIGTERM'); await child.exited; }
  }
  const report = { measured: 'Bun formal desktop service over HTTP; installed synthetic plugin and SQLite; upstream/client in a separate process',
    bun: Bun.version, platform: process.platform, arch: process.arch, clientBytesPerSecond: bytesPerSecond, memoryPeak: '20ms sampling; not an instantaneous or Cloudflare memory peak',
    cloudCpuTested: false, cloudMemoryTested: false, results };
  if (values.output) await Bun.write(values.output, JSON.stringify(report, null, 2) + '\n');
} finally { await upstream.stop(true); await rm(root, { recursive: true, force: true }); }
