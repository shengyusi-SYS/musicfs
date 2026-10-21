import { expect, test } from 'bun:test';
import type { ByteRange, Context } from '@musicfs/plugin-api';
import { NeteaseClient } from '../plugins/netease/client';
import { rawOpen, resolutionKey, sourceReader, type Resolution } from '../plugins/netease/media';
import { info } from '../plugins/netease/reference';
import { scanVersions } from '../plugins/netease/scan';
import { memoryCache } from './helpers/source-metadata';

async function fixture() {
  const bytes = Uint8Array.from({ length: 64 }, (_, index) => index);
  const counts = { api: 0, cdn: 0, reads: 0, writes: 0, cancelled: 0 };
  const cache = memoryCache(); const get = cache.get; const put = cache.put; const putMany = cache.putMany!;
  cache.get = async key => { counts.reads++; return get(key); };
  cache.put = async (...args) => { counts.writes++; return put(...args); };
  cache.putMany = async items => { counts.writes++; return putMany(items); };
  const controller = new AbortController(); const urls: string[] = [];
  let status = 206; let wrongRange = false;
  const ctx: Context = { instanceId: 'offline-netease-read', config: { quality: 'standard' }, privateState: null, cache, signal: controller.signal,
    fetch: (async (input, init) => {
      init?.signal?.throwIfAborted();
      const url = new URL(String(input));
      if (url.hostname === 'interface.music.163.com') {
        expect(url.pathname).toBe('/eapi/song/enhance/player/url/v1'); counts.api++;
        return Response.json({ code: 200, data: [{ id: 1, level: 'standard', type: 'mp3', md5: '1'.repeat(32), size: bytes.length,
          url: 'https://m1.music.126.net/source.mp3', expi: 1200 }] });
      }
      expect(url.hostname).toBe('m1.music.126.net'); counts.cdn++; urls.push(url.href);
      const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')!;
      const start = Number(match[1]); const end = Number(match[2]); const selected = bytes.slice(start, end + 1);
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(stream) { if (sent) stream.close(); else { sent = true; stream.enqueue(selected); } },
        cancel() { counts.cancelled++; }
      }, { highWaterMark: 0 }), { status, headers: { 'Content-Length': String(selected.length),
        'Content-Range': `bytes ${wrongRange ? start + 1 : start}-${end}/${bytes.length}` } });
    }) as typeof fetch };
  const initial = new NeteaseClient(ctx);
  initial.jar.setCookieSync('MUSIC_U=offline-session; Domain=.music.163.com; Path=/', 'https://music.163.com');
  ctx.privateState = { ...initial.state, cookies: JSON.stringify(initial.jar.serializeSync()) };
  const client = () => new NeteaseClient(ctx);
  const versions = await scanVersions(client(), { id: 'one-scan', playlistId: '10', ids: ['1'], revision: 'one', startedAt: new Date().toISOString() }, 0, ['1']);
  const ref = versions.get('1')!.variants[0]!.reference; const key = resolutionKey(client(), ref.id);
  cache.values.get(key)!.value = JSON.parse(JSON.stringify(cache.values.get(key)!.value));
  const saved = () => cache.values.get(key)!.value as unknown as { value: Resolution; expiresAt: number };
  for (const name of Object.keys(counts) as (keyof typeof counts)[]) counts[name] = 0;
  return { cache, ctx, controller, client, ref, key, saved, counts, urls, bytes,
    read: (range: ByteRange) => rawOpen(client(), JSON.stringify(ref), { expectedContentId: info(ref).contentId, range }),
    respond(code: number, mismatchedRange = false) { status = code; wrongRange = mismatchedRange; } };
}

test('NetEase playback and seek reuse the existing scan locator with one cache read and no SDK call per open', async () => {
  const f = await fixture(); const before = structuredClone(f.cache.values.get(f.key));
  for (const range of [{ start: 0, end: 15 }, { start: 32, end: 47 }]) {
    const result = await f.read(range);
    expect(result.content).toEqual(info(f.ref)); expect(result.servedRange).toEqual(range);
    expect(new Uint8Array(await new Response(result.body).arrayBuffer())).toEqual(f.bytes.slice(range.start, range.end + 1));
  }
  expect(f.counts).toMatchObject({ api: 0, cdn: 2, reads: 2, writes: 0 });
  expect(f.cache.values.get(f.key)).toEqual(before);
});

test('NetEase source ranges share one cached lookup and an explicit valid location takes precedence', async () => {
  const f = await fixture(); const reader = sourceReader(f.client(), f.ref);
  const ranges = [{ start: 0, end: 7 }, { start: 16, end: 23 }];
  await Promise.all(ranges.map(async range => {
    const result = await reader(range, f.ctx.signal);
    expect(new Uint8Array(await new Response(result.body).arrayBuffer())).toEqual(f.bytes.slice(range.start, range.end + 1));
  }));
  expect(f.counts).toMatchObject({ api: 0, cdn: 2, reads: 1, writes: 0 });
  const explicit = sourceReader(f.client(), f.ref, { reference: f.ref, url: 'https://m1.music.126.net/explicit.mp3', expiresAt: Date.now() + 60_000 });
  await (await explicit(ranges[0]!, f.ctx.signal)).body.cancel();
  expect(f.urls.at(-1)).toBe('https://m1.music.126.net/explicit.mp3');
  expect(f.counts).toMatchObject({ api: 0, cdn: 3, reads: 1, writes: 0 });
});

test('NetEase expired, missing and different cached media return to fresh resolution without overwriting the scan record', async () => {
  for (const invalid of ['record-expired', 'native-expired', 'different-version', 'different-location', 'incomplete', 'missing'] as const) {
    const f = await fixture(); const record = f.saved();
    if (invalid === 'record-expired') record.expiresAt = Date.now() - 1;
    if (invalid === 'native-expired') record.value.variants[0]!.location.expiresAt = Date.now() - 1;
    if (invalid === 'different-version') record.value.variants[0]!.reference.md5 = '2'.repeat(32);
    if (invalid === 'different-location') record.value.variants[0]!.location.reference.md5 = '2'.repeat(32);
    if (invalid === 'incomplete') record.value.variants = [];
    if (invalid === 'missing') f.cache.values.delete(f.key);
    const before = structuredClone(f.cache.values.get(f.key));
    const result = await f.read({ start: 0, end: 7 });
    expect(new Uint8Array(await new Response(result.body).arrayBuffer())).toEqual(f.bytes.slice(0, 8));
    expect(f.counts).toMatchObject({ api: 1, cdn: 1, reads: 1, writes: 0 });
    expect(f.cache.values.get(f.key)).toEqual(before);
  }
});

test('NetEase cached URL failures keep original invalidation and do not add a network retry', async () => {
  const f = await fixture(); f.respond(403);
  await expect(f.read({ start: 0, end: 7 })).rejects.toMatchObject({ fault: { kind: 'temporary' } });
  expect(f.counts).toMatchObject({ api: 0, cdn: 1, reads: 1, writes: 1, cancelled: 1 });
  expect(f.cache.values.get(f.key)!.value).toBeNull();
  f.respond(206);
  await (await f.read({ start: 0, end: 7 })).body.cancel();
  expect(f.counts).toMatchObject({ api: 1, cdn: 2, reads: 2, writes: 1 });
});

test('NetEase cached locations retain exact range verification, session checks and caller cancellation', async () => {
  const range = { start: 0, end: 7 };
  const wrong = await fixture(); wrong.respond(206, true);
  await expect(wrong.read(range)).rejects.toMatchObject({ fault: { kind: 'not_supported' } });
  expect(wrong.counts).toMatchObject({ api: 0, cdn: 1, reads: 1, writes: 0, cancelled: 1 });

  const expired = await fixture(); const client = expired.client();
  client.jar.setCookieSync('MUSIC_U=; Max-Age=0; Domain=.music.163.com; Path=/', 'https://music.163.com');
  await expect(rawOpen(client, JSON.stringify(expired.ref), { expectedContentId: info(expired.ref).contentId, range }))
    .rejects.toMatchObject({ fault: { kind: 'needs_auth' } });
  expect(expired.counts).toMatchObject({ api: 0, cdn: 0, reads: 0, writes: 0 });

  const stopped = await fixture(); const reason = new Error('Playback cancelled'); stopped.controller.abort(reason);
  await expect(stopped.read(range)).rejects.toBe(reason);
  expect(stopped.counts).toMatchObject({ api: 0, cdn: 0, reads: 0, writes: 0 });
});

test('NetEase hosts without plugin caching retain fresh SDK resolution', async () => {
  const f = await fixture(); delete f.ctx.cache;
  await (await f.read({ start: 0, end: 7 })).body.cancel();
  expect(f.counts).toMatchObject({ api: 1, cdn: 1, reads: 0, writes: 0 });
});
