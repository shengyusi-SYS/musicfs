import { expect, test } from 'bun:test';
import type { Context, ReadRequest } from '@musicfs/plugin-api';
import { QqClient } from '../plugins/qq/client';
import { rawOpen, sourceReader } from '../plugins/qq/media';
import { qqSession } from './helpers/qq-session';
import { memoryCache } from './helpers/source-metadata';

const filename = 'M500amediaa.mp3';
const file = JSON.stringify({ version: 1, mid: 'a', mediaId: 'mediaa', quality: '128', filename });
const bytes = Uint8Array.from({ length: 64 }, (_, index) => index);
const info = { contentId: JSON.stringify([filename, bytes.length, '"same-file"']), size: bytes.length, mediaType: 'audio/mpeg' };
const input = (start: number, end: number): ReadRequest => ({ expectedContentId: info.contentId, range: { start, end } });
const bases = [1, 2, 3, 4].map(index => `https://s${index}.stream.qqmusic.qq.com/`);

async function fixture(candidates = bases) {
  let sip = candidates; let etag = '"same-file"'; let actualFilename = filename;
  let failedHost: string | undefined; let responseStatus: number | undefined; let waiting = false;
  let apiCalls = 0; let cancelled = 0; let reads = 0; let writes = 0;
  const cdn: { url: URL; range: string | null; signal: AbortSignal | null | undefined }[] = [];
  const controller = new AbortController(); const cache = memoryCache();
  let waitingStarted!: () => void;
  const headersWaiting = new Promise<void>(resolve => { waitingStarted = resolve; });
  const originalGet = cache.get; const originalPut = cache.put;
  cache.get = async key => { reads++; return originalGet(key); };
  cache.put = async (key, value, options) => { writes++; return originalPut(key, value, options); };
  const fetcher = (async (target, init) => {
    if (init?.body) {
      apiCalls++;
      const request = JSON.parse(String(init.body)); const result: Record<string, unknown> = { code: 0 };
      for (const [key, descriptor] of Object.entries(request)) if (key.startsWith('req_')) {
        const rpc = descriptor as { method: string };
        if (rpc.method !== 'UrlGetVkey') throw new Error(`Unexpected ${rpc.method}`);
        result[key] = { code: 0, data: { sip, midurlinfo: [{ filename, songmid: 'a', purl: `${actualFilename}?vkey=request-${apiCalls}` }] } };
      }
      return Response.json(result);
    }
    const url = new URL(String(target)); const range = new Headers(init?.headers).get('range');
    cdn.push({ url, range, signal: init?.signal });
    expect(init?.redirect).toBe('manual');
    if (waiting) return new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      waitingStarted();
    });
    if (url.hostname === failedHost || responseStatus) return new Response(new Uint8Array([0]), { status: responseStatus ?? 503, headers: { 'Retry-After': '7' } });
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    const start = match ? Number(match[1]) : 0; const end = match ? Number(match[2]) : bytes.length - 1;
    const data = bytes.slice(start, end + 1);
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      start(stream) { init?.signal?.addEventListener('abort', () => stream.error(init.signal!.reason), { once: true }); },
      pull(stream) { if (sent) stream.close(); else { sent = true; stream.enqueue(data); } },
      cancel() { cancelled++; },
    });
    return new Response(body, { status: match ? 206 : 200, headers: { ETag: etag, 'Content-Length': String(data.length),
      ...(match ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
  }) as typeof fetch;
  const ctx: Context = { instanceId: 'qq-read', config: {}, privateState: await qqSession(), signal: controller.signal, fetch: fetcher, cache };
  const client = () => new QqClient(ctx, async () => { throw new Error('No HTTP facade'); });
  const open = (request: ReadRequest) => rawOpen(client(), file, request);
  return { ctx, cache, controller, cdn, client, open, headersWaiting,
    get counts() { return { api: apiCalls, cdn: cdn.length, reads, writes, cancelled }; },
    setFailedHost(value: string) { failedHost = value; }, setEtag(value: string) { etag = value; },
    setStatus(value: number) { responseStatus = value; }, setWaiting() { waiting = true; },
    setCandidates(value: string[]) { sip = value; }, setFilename(value: string) { actualFilename = value; } };
}
async function consume(result: Awaited<ReturnType<typeof rawOpen>>, start: number, end: number) {
  expect(result.content).toEqual(info);
  expect(new Uint8Array(await new Response(result.body).arrayBuffer())).toEqual(bytes.slice(start, end + 1));
}

test('QQ playback then two seeks keep fresh vkeys and replace repeated CDN probes with exact validated reads', async () => {
  for (const candidates of [bases.slice(0, 1), bases]) {
    const f = await fixture(candidates);
    await consume(await f.open(input(0, 15)), 0, 15);
    expect(f.counts).toMatchObject({ api: 1, cdn: candidates.length + 1, reads: 1, writes: 1 });
    await consume(await f.open(input(32, 47)), 32, 47);
    await consume(await f.open(input(48, 63)), 48, 63);
    expect(f.counts).toMatchObject({ api: 3, cdn: candidates.length + 3, reads: 3, writes: 1 });
    const preferred = f.cache.values.get('stream-base')!;
    expect(candidates).toContain(preferred.value as string);
    expect(JSON.stringify(preferred)).not.toContain('vkey');
    expect(f.cdn.at(-1)!.url.search).toBe('?vkey=request-3');
  }
});

test('QQ one open shares fresh location across concurrent tag ranges while later opens reuse only the route', async () => {
  const f = await fixture();
  const prepare = sourceReader(f.client(), file, info);
  const ranges = [{ start: 4, end: 7 }, { start: 16, end: 23 }, { start: 56, end: 63 }];
  await Promise.all(ranges.map(async range => consume(await prepare(range, f.ctx.signal), range.start, range.end)));
  expect(f.counts).toMatchObject({ api: 1, cdn: 7, reads: 1, writes: 1 });
  const read = sourceReader(f.client(), file, info);
  await Promise.all(ranges.map(async range => consume(await read(range, f.ctx.signal), range.start, range.end)));
  expect(f.counts).toMatchObject({ api: 2, cdn: 10, reads: 2, writes: 1 });
});

test('QQ expired or replaced routing preferences return to the existing bounded SDK selector', async () => {
  const f = await fixture(); await consume(await f.open(input(0, 15)), 0, 15);
  f.cache.values.get('stream-base')!.expiresAt = Date.now() - 1;
  await consume(await f.open(input(32, 47)), 32, 47);
  expect(f.counts).toMatchObject({ api: 2, cdn: 10, reads: 2, writes: 2 });
  f.setCandidates(['https://new.stream.qqmusic.qq.com/']);
  await consume(await f.open(input(48, 63)), 48, 63);
  expect(f.counts).toMatchObject({ api: 3, cdn: 12, reads: 3, writes: 3 });
  expect(f.cdn.at(-1)!.url.hostname).toBe('new.stream.qqmusic.qq.com');
});

test('QQ failed preferred route returns once to SDK selection before any bytes escape', async () => {
  const f = await fixture(); await consume(await f.open(input(0, 15)), 0, 15);
  const preferred = new URL(f.cache.values.get('stream-base')!.value as string).hostname;
  f.setFailedHost(preferred);
  await consume(await f.open(input(32, 47)), 32, 47);
  expect(f.counts).toMatchObject({ api: 2, cdn: 11, reads: 2, writes: 3 });
  expect(f.cdn.at(-1)!.url.hostname).not.toBe(preferred);
  await consume(await f.open(input(48, 63)), 48, 63);
  expect(f.counts).toMatchObject({ api: 3, cdn: 12, reads: 3, writes: 3 });
});

test('QQ changed identity, rate limits and caller cancellation never become route fallback', async () => {
  for (const failure of ['etag', 'vkey', '429', 'abort'] as const) {
    const f = await fixture(); await consume(await f.open(input(0, 15)), 0, 15);
    const before = f.counts;
    if (failure === 'etag') f.setEtag('"changed"');
    if (failure === 'vkey') f.setFilename('M800amediaa.mp3');
    if (failure === '429') f.setStatus(429);
    if (failure === 'abort') f.setWaiting();
    const pending = f.open(input(32, 47));
    if (failure === 'abort') {
      await f.headersWaiting;
      f.controller.abort(new Error('Caller stopped playback'));
      await expect(pending).rejects.toThrow('Caller stopped playback');
    } else await expect(pending).rejects.toMatchObject({ fault: {
      kind: failure === '429' ? 'rate_limited' : 'content_changed', ...(failure === '429' ? { retryAfterSeconds: 7 } : {}),
    } });
    expect(f.counts).toMatchObject({ api: before.api + 1, cdn: before.cdn + (failure === 'vkey' ? 0 : 1), writes: before.writes });
  }
});

test('QQ preferred-route responses preserve caller cancellation after headers', async () => {
  const f = await fixture(); await consume(await f.open(input(0, 15)), 0, 15);
  const result = await f.open(input(32, 47));
  const passed = f.cdn.at(-1)!.signal!;
  expect(passed.aborted).toBe(false);
  f.controller.abort(new Error('Stopped after headers'));
  expect(passed.aborted).toBe(true);
  await expect(new Response(result.body).arrayBuffer()).rejects.toThrow('Stopped after headers');
});

test('QQ hosts without a plugin cache retain the original fresh selection path', async () => {
  const f = await fixture(); delete f.ctx.cache;
  await consume(await f.open(input(0, 15)), 0, 15);
  await consume(await f.open(input(32, 47)), 32, 47);
  expect(f.counts).toMatchObject({ api: 2, cdn: 10, reads: 0, writes: 0 });
});
