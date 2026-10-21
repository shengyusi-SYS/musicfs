import { expect, test } from 'bun:test';
import type { ByteRange, Context, ReadResult } from '@musicfs/plugin-api';
import { prepare } from '../packages/audio-tags/src';
import { fixture as audioFixture } from '../packages/audio-tags/test-fixtures';
import { NeteaseClient } from '../plugins/netease/client';
import { sourceReader } from '../plugins/netease/media';
import { info, type MediaReference } from '../plugins/netease/reference';
import { memoryCache } from './helpers/source-metadata';

const bodyBytes = async (result: ReadResult) => new Uint8Array(await new Response(result.body).arrayBuffer());
function fixture(mode: 'multipart' | 'full' | 'single' = 'multipart') {
  const { bytes } = audioFixture('mp3'); const requests: string[] = []; let cancelled = 0; let bad = ''; let response: Response | undefined;
  const controller = new AbortController(); const signal = controller.signal;
  const ref: MediaReference = { version: 1, id: '1', level: 'standard', type: 'mp3', md5: '1'.repeat(32), size: bytes.length };
  async function multipart(ranges: ByteRange[]) {
    const boundary = 'musicfs-cdn-boundary'; const chunks: BlobPart[] = [];
    for (const [index, range] of [...ranges].reverse().entries()) {
      const total = bytes.length + (bad === 'total' && index === 0 ? 1 : 0);
      chunks.push(`--${boundary}\r\nContent-Type: audio/mpeg\r\nContent-Range: bytes ${range.start}-${range.end}/${total}\r\n\r\n`,
        bytes.slice(range.start, range.end + 1 - (bad === 'short' && index === 0 ? 1 : 0)), '\r\n');
    }
    chunks.push(`--${boundary}--\r\n`);
    const payload = new Uint8Array(await new Blob(chunks).arrayBuffer());
    // Reproduce the observed CDN: multipart bytes, but an incorrect outer media type.
    return new Response(payload, { status: 206, headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(payload.length) } });
  }
  const ctx: Context = { instanceId: 'offline-multi-range', config: { quality: 'standard' }, privateState: null, signal, cache: memoryCache(),
    fetch: (async (_input, init) => {
      const rangeHeader = new Headers(init?.headers).get('range')!; requests.push(rangeHeader);
      if (response) return response;
      const ranges = rangeHeader.slice(6).split(',').map(value => { const [start, end] = value.split('-').map(Number); return { start: start!, end: end! }; });
      if (ranges.length > 1 && mode === 'multipart') return multipart(ranges);
      if (ranges.length > 1 && mode === 'full') return new Response(new ReadableStream({ cancel() { cancelled++; } }), {
        status: 200, headers: { 'Content-Length': String(bytes.length) } });
      const range = ranges[0]!; const data = bytes.slice(range.start, range.end + 1);
      if (ranges.length > 1) return new Response(new ReadableStream({ cancel() { cancelled++; } }), {
        status: 206, headers: { 'Content-Range': `bytes ${range.start}-${range.end}/${bytes.length}`, 'Content-Length': String(data.length) } });
      return new Response(data, { status: 206, headers: { 'Content-Range': `bytes ${range.start}-${range.end}/${bytes.length}`, 'Content-Length': String(data.length) } });
    }) as typeof fetch };
  const client = new NeteaseClient(ctx);
  const reader = (id = '1', changed = false) => {
    const source = { ...ref, id };
    return sourceReader(client, source, { reference: { ...source, ...(changed ? { md5: '2'.repeat(32) } : {}) },
      url: `https://m1.music.126.net/${id}.mp3`, expiresAt: Date.now() + 60_000 });
  };
  const ranges = [{ start: 0, end: 4095 }, { start: bytes.length - 128, end: bytes.length - 1 }];
  return { ref, bytes, requests, signal, reader, ranges, cancelled: () => cancelled, corrupt(value: string) { bad = value; },
    respond(value: Response) { response = value; }, abort() { controller.abort(); } };
}

test('NetEase reads exact multipart ranges in requested order despite the observed CDN content-type quirk', async () => {
  const f = fixture(); const results = await f.reader().readMany!(f.ranges, f.signal);
  expect(f.requests).toEqual([`bytes=0-4095,${f.bytes.length - 128}-${f.bytes.length - 1}`]);
  for (const [index, result] of results.entries()) {
    const range = f.ranges[index]!;
    expect(result.content).toEqual(info(f.ref)); expect(result.servedRange).toEqual(range);
    expect(await bodyBytes(result)).toEqual(f.bytes.slice(range.start, range.end + 1));
  }
});

test('NetEase does not mask changed versions, mismatched multipart totals or short parts as unsupported batching', async () => {
  const changed = fixture();
  await expect(changed.reader('1', true).readMany!(changed.ranges, changed.signal)).rejects.toMatchObject({ fault: { kind: 'content_changed' } });
  expect(changed.requests).toHaveLength(0);
  for (const invalid of ['total', 'short']) {
    const f = fixture(); f.corrupt(invalid);
    await expect(f.reader().readMany!(f.ranges, f.signal)).rejects.toMatchObject({ fault: { kind: 'content_changed' } });
    expect(f.requests).toHaveLength(1);
  }
});

for (const mode of ['full', 'single'] as const) {
  test(`NetEase cancels an unsupported ${mode} response and remembers the CDN for subsequent files`, async () => {
    const f = fixture(mode);
    for (const id of ['1', '2']) {
      const results = await f.reader(id).readMany!(f.ranges, f.signal);
      for (const [index, result] of results.entries()) expect(await bodyBytes(result)).toEqual(f.bytes.slice(f.ranges[index]!.start, f.ranges[index]!.end + 1));
    }
    expect(f.cancelled()).toBe(1);
    expect(f.requests).toEqual([`bytes=0-4095,${f.bytes.length - 128}-${f.bytes.length - 1}`,
      'bytes=0-4095', `bytes=${f.bytes.length - 128}-${f.bytes.length - 1}`, 'bytes=0-4095', `bytes=${f.bytes.length - 128}-${f.bytes.length - 1}`]);
  });
}

test('NetEase MP3 preparation replaces two CDN requests with one while retaining identical final tagged bytes', async () => {
  const baseline = fixture(); const reader = baseline.reader(); delete reader.readMany;
  const expected = await prepare({ format: 'mp3', sourceInfo: info(baseline.ref), readRange: reader, tags: { title: 'Updated title' }, signal: baseline.signal });
  const optimized = fixture();
  const actual = await prepare({ format: 'mp3', sourceInfo: info(optimized.ref), readRange: optimized.reader(), tags: { title: 'Updated title' }, signal: optimized.signal });
  expect(actual).toEqual(expected); expect(baseline.requests).toHaveLength(2); expect(optimized.requests).toHaveLength(1);
});

test('NetEase multi-range retains Retry-After and never consumes an oversized response as a full audio file', async () => {
  const limited = fixture(); limited.respond(new Response('rate limited', { status: 429, headers: { 'Retry-After': '9' } }));
  await expect(limited.reader().readMany!(limited.ranges, limited.signal)).rejects.toMatchObject({ fault: { kind: 'rate_limited', retryAfterSeconds: 9 } });
  expect(limited.requests).toHaveLength(1);
  const oversized = fixture(); let reads = 0; let cancelled = false;
  oversized.respond(new Response(new ReadableStream({ type: 'bytes', pull() { reads++; }, cancel() { cancelled = true; } }), {
    status: 206, headers: { 'Content-Length': '100000000', 'Content-Type': 'audio/mpeg' } }));
  await expect(oversized.reader().readMany!(oversized.ranges, oversized.signal)).rejects.toMatchObject({ fault: { kind: 'temporary' } });
  expect(reads).toBe(0); expect(cancelled).toBe(true); expect(oversized.requests).toHaveLength(1);
});

test('NetEase cancels an in-flight multipart body when its preparation is aborted', async () => {
  const f = fixture(); let started!: () => void; const reading = new Promise<void>(resolve => { started = resolve; }); let cancelled = false;
  f.respond(new Response(new ReadableStream({ type: 'bytes', pull() { started(); }, cancel() { cancelled = true; } }), { status: 206 }));
  const result = f.reader().readMany!(f.ranges, f.signal);
  await reading; f.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' }); expect(cancelled).toBe(true); expect(f.requests).toHaveLength(1);
});
