/** Valid synthetic audio behind the real Library/DAV path. Shared by bounded DAV and VM probes. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ByteRange, SourcePlugin } from '@musicfs/plugin-api';
import { open, prepare, type ReadRange, type TaggedPlan } from '../../packages/audio-tags/src';
import { createDav } from '../../src/transport/dav';
import { libraryFixture } from '../../tests/helpers/library-fixture';

export async function createReadCacheFixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'musicfs-read-cache-'));
  const path = join(scratch, 'source.mp3');
  const generator = Bun.spawn(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=120',
    '-c:a', 'libmp3lame', '-b:a', '320k', '-y', path], { stdout: 'ignore', stderr: 'pipe' });
  assert.equal(await generator.exited, 0, await new Response(generator.stderr).text());
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const source = { contentId: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'), size: bytes.length, mediaType: 'audio/mpeg' };
  const content = { ...source, contentId: `offline-tagged:${source.contentId}`, size: source.size + 1_048_576, modifiedAt: '2026-10-21T00:00:00.000Z' };
  let title = 'Cache fixture title';
  const names = ['Track 1.mp3', 'Track 2.mp3', 'Track 3.mp3'];
  const fresh = () => ({ dav: [] as { method: string; range: string | null; status: number }[],
    source: [] as { range: ByteRange; phase: string; sentBytes: number; consumedBytes: number }[], preparations: 0 });
  let stats = fresh(), preparing = false, plan: Promise<TaggedPlan> | undefined;
  const cdn = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch(request) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('range') ?? ''); assert(match);
    const range = { start: Number(match[1]), end: Number(match[2]) };
    const item = { range, phase: new URL(request.url).searchParams.get('phase') ?? 'read', sentBytes: 0, consumedBytes: 0 };
    stats.source.push(item); let offset = range.start;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset > range.end) { controller.close(); return; }
      const end = Math.min(range.end + 1, offset + 16 * 1024), data = bytes.slice(offset, end);
      offset = end; item.sentBytes += data.length; controller.enqueue(data);
    } }, { highWaterMark: 0 }), { status: 206, headers: { 'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${bytes.length}` } });
  } });
  const reader: ReadRange = async (range, signal) => {
    const phase = preparing ? 'preparation' : 'read';
    const response = await fetch(new URL(`/?phase=${phase}`, cdn.url), { signal, headers: { Range: `bytes=${range.start}-${range.end}` } });
    assert.equal(response.status, 206);
    const item = stats.source.findLast(item => item.range.start === range.start && item.range.end === range.end && item.phase === phase)!;
    const stream = response.body!.getReader();
    return { content: source, servedRange: range, body: new ReadableStream<Uint8Array>({
      async pull(controller) { const next = await stream.read(); if (next.done) { stream.releaseLock(); controller.close(); }
        else { item.consumedBytes += next.value.length; controller.enqueue(next.value); } },
      async cancel(reason) { await stream.cancel(reason); stream.releaseLock(); }
    }, { highWaterMark: 0 }) };
  };
  const getPlan = () => plan ??= (async () => {
    stats.preparations++; preparing = true;
    try {
      const prepared = await prepare({ format: 'mp3', sourceInfo: source, readRange: reader, reserveBytes: 1_048_576,
        tags: { title, artists: ['Fixture artist'], album: 'Fixture album',
          cover: { mimeType: 'image/jpeg', data: new Uint8Array(await Bun.file('tests/fixtures/source-metadata/cover.jpg').arrayBuffer()) },
          lyrics: { original: '[00:00.00]Offline cache fixture\n[00:01.00]Second line' } }, signal: new AbortController().signal });
      assert.equal(prepared.content.size, content.size); return { ...prepared, content };
    } finally { preparing = false; }
  })();
  const plugin: SourcePlugin = {
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, value) => ({ ok: true, value }),
    roots: async () => ({ ok: true, value: { items: [{ sourceId: 'root', name: 'Music', directoryRef: 'root' }] } }),
    list: async () => ({ ok: true, value: { items: names.map(name => ({ kind: 'file' as const, entryId: name, name, fileRef: name, info: content })) } }),
    stat: async () => ({ ok: true, value: content }),
    open: async (ctx, _file, request) => ({ ok: true, value: await open(await getPlan(), reader, request.range, ctx.signal) })
  };
  const f = await libraryFixture(plugin); const dav = createDav(f.library.files, { username: 'reader', password: 'fixture' });
  await f.library.refresh(f.id, undefined, new AbortController().signal); await f.library.refresh(f.id, 'root', new AbortController().signal);
  const snapshot = () => structuredClone({ ...stats, sourceSize: source.size, finalSize: content.size, libraryPath: '实例 & #/Music',
    selected: names[0], title, names });
  const reset = () => { stats = fresh(); };
  const expected = async () => {
    assert(plan, 'Do not prepare the fixture through the verification endpoint');
    const local: ReadRange = async range => ({ content: source, servedRange: range, body: new Blob([bytes.slice(range.start, range.end + 1)]).stream() });
    const full = new Uint8Array(await new Response((await open(await plan, local, undefined, new AbortController().signal)).body).arrayBuffer());
    return { bytes: full.length, sha256: new Bun.CryptoHasher('sha256').update(full).digest('hex'),
      samples: [0, full.length - 128].map(offset => ({ offset, base64: Buffer.from(full.slice(offset, offset + 64)).toString('base64') })) };
  };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__probe/state') return Response.json(snapshot());
    if (url.pathname === '/__probe/reset' && request.method === 'POST') { reset(); return Response.json({ reset: true }); }
    if (url.pathname === '/__probe/expected') return Response.json(await expected());
    const current = stats; const response = await dav.fetch(request);
    current.dav.push({ method: request.method, range: request.headers.get('range'), status: response.status }); return response;
  } });
  return { server, files: f.library.files, url: new URL('/dav/' + ['实例 & #', 'Music', 'Track 1.mp3'].map(encodeURIComponent).join('/'), server.url).href, content,
    snapshot, reset, expected, async reviseTitle(value: string) {
      title = value; content.contentId += ':updated'; plan = undefined;
      await f.library.refresh(f.id, 'root', new AbortController().signal);
    }, async close() { await server.stop(true); await cdn.stop(true); f.close(); await rm(scratch, { recursive: true, force: true }); } };
}
