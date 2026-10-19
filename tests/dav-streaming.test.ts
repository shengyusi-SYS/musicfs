import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { SourcePlugin } from '@musicfs/plugin-api';
import { createDav } from '../src/transport/dav';
import { libraryFixture } from './helpers/library-fixture';

let upstream: Bun.Server<undefined>; let server: Bun.Server<undefined>; let fixture: Awaited<ReturnType<typeof libraryFixture>>;
const bytes = Uint8Array.from({ length: 8192 }, (_, n) => n % 251);
const seenRanges: (string | null)[] = []; let cancelled = false;
const authorization = 'Basic ' + Buffer.from('reader:fixture').toString('base64');
const info = (file: string) => ({ contentId: `fixed-${file}`, size: file === 'big' ? 5 * 1024 ** 3 : file === 'slow' ? 1024 * 1024 : file === 'short' ? 8 : bytes.length, mediaType: 'audio/wav' });
beforeAll(async () => {
  upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname.slice(1); const range = request.headers.get('Range'); seenRanges.push(range);
    if (path === 'big') {
      const parts = /^bytes=(\d+)-(\d+)$/.exec(range ?? ''); if (!parts) return new Response(null, { status: 400 });
      const start = Number(parts[1]); const end = Number(parts[2]);
      return new Response(Uint8Array.from({ length: end - start + 1 }, (_, n) => (start + n) % 251), {
        status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${5 * 1024 ** 3}` }
      });
    }
    if (path === 'slow') {
      let count = 0;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 10));
          if (cancelled) return;
          if (count++ < 256) controller.enqueue(new Uint8Array(4096)); else controller.close();
        }, cancel() { cancelled = true; }
      }));
    }
    if (path === 'short') return new Response(new Uint8Array([1, 2]));
    const parsed = path === 'ignored' ? null : /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    if (parsed) {
      const start = Number(parsed[1]); const end = Number(parsed[2]);
      return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
    }
    return new Response(bytes);
  } });
  const plugin: SourcePlugin = {
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, candidate) => ({ ok: true, value: candidate }),
    roots: async () => ({ ok: true, value: { items: [{ sourceId: 'audio', name: '来源', directoryRef: '/' }] } }),
    list: async () => ({ ok: true, value: { items: ['audio', 'ignored', 'short', 'slow', 'big'].map(file => ({ kind: 'file', entryId: file, name: file + '.wav', fileRef: file })) } }),
    stat: async (_ctx, file) => ({ ok: true, value: info(file) }),
    async open(ctx, file, request) {
      const response = await ctx.fetch(new URL('/' + file, upstream.url), { signal: ctx.signal,
        headers: request.range ? { Range: `bytes=${request.range.start}-${request.range.end}` } : {} });
      if (!response.body) throw new Error('No upstream body');
      return { ok: true, value: { content: info(file), servedRange: response.status === 206 ? request.range ?? null : null, body: response.body } };
    }
  };
  fixture = await libraryFixture(plugin);
  const app = createDav(fixture.library.files, { username: 'reader', password: 'fixture' });
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
});
afterAll(async () => { if (server) await server.stop(true); if (upstream) await upstream.stop(true); fixture?.close(); });
const url = (file: string) => new URL('/dav/' + ['实例 & #', '来源', file + '.wav'].map(encodeURIComponent).join('/'), server.url);

test('a client range reaches the actual upstream HTTP server and returns exact bytes', async () => {
  const response = await fetch(url('audio'), { headers: { Authorization: authorization, Range: 'bytes=1000-2024' } });
  expect(response.status).toBe(206); expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(1000, 2025));
  expect(seenRanges).toContain('bytes=1000-2024');
});
test('an upstream that ignores Range is rejected before any fake 206 body', async () => {
  const response = await fetch(url('ignored'), { headers: { Authorization: authorization, Range: 'bytes=1-3' } });
  expect(response.status).toBe(502); await response.body?.cancel();
});
test('a range beyond 4 GiB reaches the upstream without reading the preceding bytes', async () => {
  const start = 4 * 1024 ** 3 + 17; const end = start + 1024;
  const response = await fetch(url('big'), { headers: { Authorization: authorization, Range: `bytes=${start}-${end}` } });
  expect(response.status).toBe(206); expect(response.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/${5 * 1024 ** 3}`);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from({ length: 1025 }, (_, n) => (start + n) % 251));
  expect(seenRanges).toContain(`bytes=${start}-${end}`);
});
test('truncated upstream audio produces a failed transfer rather than normal EOF', async () => {
  await expect((async () => {
    const response = await fetch(url('short'), { headers: { Authorization: authorization } });
    if (!response.ok) throw new Error('Audio failed before headers');
    await response.arrayBuffer();
  })()).rejects.toThrow();
});
test('client cancellation reaches the real upstream stream', async () => {
  const controller = new AbortController();
  const response = await fetch(url('slow'), { headers: { Authorization: authorization }, signal: controller.signal });
  const reader = response.body!.getReader(); await reader.read(); controller.abort(); await reader.cancel().catch(() => {});
  const deadline = Date.now() + 2000;
  while (!cancelled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  expect(cancelled).toBe(true);
});
