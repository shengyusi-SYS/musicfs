import { expect, test } from 'bun:test';
import type { Context } from '@musicfs/plugin-api';
import { musicTags as neteaseTags } from '../plugins/netease/metadata';
import { musicTags as qqTags } from '../plugins/qq/metadata';
import { endpoints } from '../plugins/netease/generated-upstream.mjs';
import { NeteaseFailure, type NeteaseClient } from '../plugins/netease/client';
import { QqFailure, type QqClient } from '../plugins/qq/client';
import { cover } from '../packages/audio-tags/test-fixtures';
import { memoryCache } from './helpers/source-metadata';

function fixture(provider: 'netease' | 'qq') {
  const gates = { lyrics: Promise.withResolvers<void>(), cover: Promise.withResolvers<void>() };
  const started = { lyrics: Promise.withResolvers<void>(), cover: Promise.withResolvers<void>() };
  const controller = new AbortController(); const cache = memoryCache();
  const requests: string[] = []; let active = 0; let peak = 0;
  async function read(kind: keyof typeof gates) {
    controller.signal.throwIfAborted(); requests.push(kind); active++; peak = Math.max(peak, active);
    started[kind].resolve();
    try { await gates[kind].promise; controller.signal.throwIfAborted(); }
    finally { active--; }
  }
  const ctx: Context = { instanceId: 'offline-metadata-scheduling', config: {}, privateState: null, cache, signal: controller.signal,
    fetch: (async input => {
      const url = new URL(String(input));
      const kind = url.hostname === 'c.y.qq.com' ? 'lyrics' : 'cover';
      await read(kind);
      return kind === 'cover' ? new Response(cover, { headers: { 'content-type': 'image/png' } })
        : Response.json({ code: 0, lyric: '[00:00.00]Original', trans: 'Translation', roma: 'Romanization' });
    }) as typeof fetch };
  const netease = { ctx, async call(endpoint: unknown) {
    expect(endpoint).toBe(endpoints.lyric); await read('lyrics');
    return { lrc: { lyric: '[00:00.00]Original' }, tlyric: { lyric: 'Translation' }, romalrc: { lyric: 'Romanization' } };
  } } as unknown as NeteaseClient;
  const qq = { ctx } as QqClient;
  const song = { id: 1, name: 'Song', ar: [{ name: 'Artist' }],
    al: { id: 1, name: 'Album', artists: [{ name: 'Artist' }], publishTime: 1577836800000, picUrl: 'https://p1.music.126.net/cover.png' } };
  const qqSong = { mid: 'one', title: 'Song', singer: [{ name: 'Artist' }], index_album: 1, index_cd: 1,
    album: { mid: 'one', name: 'Album', singer: [{ name: 'Artist' }], aDate: '2020-01-01' } };
  return { gates, started, requests, cache, controller, get active() { return active; }, get peak() { return peak; },
    run: (concurrency: 1 | 2) => provider === 'netease' ? neteaseTags(netease, song, concurrency) : qqTags(qq, qqSong, concurrency) };
}

for (const provider of ['netease', 'qq'] as const) {
  test(`${provider}: one-file metadata overlaps two assets with the same tags, request count and warm cache`, async () => {
    const serial = fixture(provider);
    const old = serial.run(1);
    await serial.started.lyrics.promise;
    expect(serial.requests).toEqual(['lyrics']);
    serial.gates.lyrics.resolve(); await serial.started.cover.promise; serial.gates.cover.resolve();
    const expected = await old;
    const parallel = fixture(provider);
    const next = parallel.run(2);
    await Promise.all([parallel.started.lyrics.promise, parallel.started.cover.promise]);
    expect(parallel.peak).toBe(2);
    parallel.gates.lyrics.resolve(); parallel.gates.cover.resolve();
    const actual = await next;
    expect(actual.tags).toEqual(expected.tags); expect(parallel.requests).toEqual(serial.requests);
    expect((await parallel.run(2)).tags).toEqual(actual.tags);
    expect(parallel.requests).toHaveLength(2); expect(parallel.active).toBe(0);
  });

  test(`${provider}: concurrent failures drain both assets and preserve the source cooldown`, async () => {
    const f = fixture(provider); let returned = false;
    const failure = provider === 'netease' ? new NeteaseFailure({ kind: 'rate_limited', message: 'fixture', retryAfterSeconds: 7 })
      : new QqFailure({ kind: 'rate_limited', message: 'fixture', retryAfterSeconds: 7 });
    const outcome = f.run(2).catch(error => { returned = true; return error; });
    await Promise.all([f.started.lyrics.promise, f.started.cover.promise]);
    f.gates.lyrics.reject(provider === 'netease' ? new NeteaseFailure({ kind: 'temporary', message: 'fixture' })
      : new QqFailure({ kind: 'temporary', message: 'fixture' }));
    await Promise.resolve(); expect(returned).toBe(false);
    f.gates.cover.reject(failure);
    expect(await outcome).toBe(failure); expect(f.active).toBe(0); expect(f.requests).toHaveLength(2);
  });

  test(`${provider}: cancelled parallel assets cannot write metadata after the invocation settles`, async () => {
    const f = fixture(provider); const outcome = f.run(2).catch(error => error);
    await Promise.all([f.started.lyrics.promise, f.started.cover.promise]);
    const reason = new Error('fixture cancellation'); f.controller.abort(reason);
    f.gates.lyrics.resolve(); f.gates.cover.resolve();
    expect(await outcome).toBe(reason); expect(f.active).toBe(0);
    expect([...f.cache.values.keys()].some(key => key.includes('lyrics') || key.includes('cover'))).toBe(false);
  });
}
