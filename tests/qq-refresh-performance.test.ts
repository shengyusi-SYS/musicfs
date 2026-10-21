import { expect, test } from 'bun:test';
import type { Context, Entry, Json } from '@musicfs/plugin-api';
import { list } from '../plugins/qq/catalog';
import { QqRequestBudgetFailure, type QqClient } from '../plugins/qq/client';
import { cover } from '../packages/audio-tags/test-fixtures';
import { mediaBytes } from './helpers/source-metadata';

function fixture(count: number, options: { legacy?: boolean; worker?: boolean; fallback?: boolean } = {}) {
  const values = new Map<string, { value: Json; expiresAt: number | undefined }>();
  const calls: Record<string, number> = {};
  const reads: Record<string, number> = {};
  let planBytes = 0; let queries = 0; let requests = 0; let firstWrite = true;
  const costs: { queries: number; requests: number }[] = [];
  const writeCost = () => { queries += firstWrite ? 2 : 1; firstWrite = false; };
  const hit = (target: Record<string, number>, key: string) => { target[key] = (target[key] ?? 0) + 1; };
  const audio = mediaBytes.mp3;
  const picture = new Uint8Array(32_768); picture.set(cover);
  let title = 'Song'; let etag = '"fixture-audio"'; let fallbackFrom = options.fallback ? 1 : Infinity;
  const requestCost = () => { if (requests >= 45) throw new QqRequestBudgetFailure(); requests++; };
  const songs = Array.from({ length: count }, (_, index) => ({ mid: `song${index + 1}`, title: `Song ${index + 1}`,
    singer: [{ name: 'Artist' }], file: { media_mid: `media${index + 1}` },
    album: { mid: 'sharedAlbum', name: 'Album' }, index_album: index + 1, index_cd: 1 }));
  const cached = (key: string) => {
    const saved = values.get(key);
    return saved && (saved.expiresAt === undefined || saved.expiresAt > Date.now()) ? structuredClone(saved.value) : undefined;
  };
  const cache: NonNullable<Context['cache']> = {
    async get(key) { queries++; hit(reads, key.split(':')[0]!); const value = cached(key); if (key.startsWith('tag-plan:') && value) planBytes += JSON.stringify(value).length; return value; },
    async getMany(keys) { if (keys.length) { queries++; hit(reads, 'getMany'); } return keys.map(cached); },
    async put(key, value, options) { writeCost(); values.set(key, { value: structuredClone(value), expiresAt: options?.expiresAt }); },
    async putMany(items) { if (items.length) writeCost(); for (const item of items) values.set(item.key, { value: structuredClone(item.value), expiresAt: item.expiresAt }); }
  };
  if (options.legacy) { delete cache.getMany; delete cache.putMany; }
  const ctx: Context = { instanceId: 'offline-qq', config: {}, privateState: null, signal: new AbortController().signal, cache,
    fetch: (async (input, init) => {
      requestCost();
      const url = new URL(String(input));
      if (url.hostname === 'c.y.qq.com') {
        if (url.pathname.includes('/lyric/')) { hit(calls, 'lyrics'); return Response.json({ code: 0, lyric: '[00:00.00]Original', trans: '[00:00.00]Translation', roma: '[00:00.00]Romanization' }); }
        if (url.pathname.includes('/fcg_v8_album_info')) { hit(calls, 'album'); return Response.json({ code: 0, data: { name: 'Album', aDate: '2020-02-03', singer: [{ name: 'Artist' }], total: count } }); }
      }
      if (url.hostname === 'y.gtimg.cn') { hit(calls, 'cover'); return new Response(picture, { headers: { 'content-type': 'image/png' } }); }
      if (!/^(?:[sd][1-4]|dl)\.stream\.qqmusic\.qq\.com$/.test(url.hostname)) throw new Error(`Unexpected offline request ${url.hostname}`);
      const track = Number(/song(\d+)media/.exec(url.pathname)?.[1]);
      if (track >= fallbackFrom && url.hostname !== 'dl.stream.qqmusic.qq.com') { hit(calls, 'failedProbe'); return new Response(null, { status: 503 }); }
      const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')!;
      const start = Number(range[1]); const end = Number(range[2]);
      hit(calls, start === 0 && end === 0 ? 'probe' : 'range');
      return new Response(audio.slice(start, end + 1), { status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${audio.length}`, 'content-length': String(end - start + 1), etag } });
    }) as typeof fetch };
  if (options.worker) ctx.workBudget = { get remaining() { return Math.min(32 - queries, 45 - requests); } };
  const client = () => { queries = 0; requests = 0; firstWrite = true; return ({ ctx, requireSession() {},
    async rpc(describe: (session: unknown) => unknown) {
      const query = describe({ credential: { encryptUin: 'offline', musicid: '123' } }) as { method: string; param: Record<string, number> };
      if (query.method === 'GetCdnDispatch') { requestCost(); hit(calls, 'dispatch'); return { sip: [1, 2, 3, 4].map(index => `https://d${index}.stream.qqmusic.qq.com/`) }; }
      if (query.method !== 'CgiGetDiss') throw new Error('Unexpected offline RPC');
      requestCost(); hit(calls, 'playlist'); const offset = query.param.song_begin!; const size = query.param.song_num!;
      return { songlist: songs.slice(offset, offset + size).map(song => ({ ...song, title: song.title.replace('Song', title) })), total_song_num: songs.length };
    },
    async rpcBatch(describe: (session: unknown) => unknown[]) {
      requestCost(); hit(calls, 'playback');
      return describe({ credential: { musicid: '123' } }).map(raw => {
        const query = raw as { method: string; param: { filename: string[]; songmid: string[] } };
        if (query.method !== 'UrlGetVkey') throw new Error('Unexpected offline batch');
        const expensive = Number(/song(\d+)/.exec(query.param.songmid[0]!)?.[1]) >= fallbackFrom;
        return { sip: (expensive ? [1, 2, 3, 4] : [1]).map(index => `https://s${index}.stream.qqmusic.qq.com/`), midurlinfo: query.param.filename.map((filename, index) => ({ filename, songmid: query.param.songmid[index], purl: filename })) };
      });
    }
  } as unknown as QqClient); };
  return { client, ctx, values, calls, reads, costs, finishPage() { costs.push({ queries, requests }); },
    get planBytes() { return planBytes; }, rename(value: string) { title = value; }, changeAudio() { etag = '"fixture-new-audio"'; }, slowFrom(position: number) { fallbackFrom = position; },
    repeatFirst() { songs.splice(1, 0, { ...songs[0]! }); },
    reset() { for (const map of [calls, reads]) for (const key of Object.keys(map)) delete map[key]; planBytes = 0; } };
}

async function scan(f: ReturnType<typeof fixture>) {
  let cursor: string | undefined; let pages = 0; let tracks = 0; const items: Entry[] = [];
  do { const page = await list(f.client(), 'liked', cursor); f.finishPage(); pages++; items.push(...page.items); cursor = page.nextCursor;
    tracks += page.statistics?.tracks ?? 0; expect(page.progress).toMatchObject({ completed: tracks });
  } while (cursor);
  return { pages, items };
}

test('QQ hot refresh batches small ready indexes without loading metadata or large plans', async () => {
  const f = fixture(20); const cold = await scan(f);
  const coldReport = { pages: cold.pages, calls: { ...f.calls }, reads: { ...f.reads }, planBytes: f.planBytes,
    maxPluginQueries: Math.max(...f.costs.map(cost => cost.queries)), maxSourceRequests: Math.max(...f.costs.map(cost => cost.requests)) };
  const warmStart = f.costs.length;
  f.reset(); const warm = await scan(f);
  expect(warm.items).toEqual(cold.items); expect(warm.items).toHaveLength(20);
  expect(cold.pages).toBe(5); expect(warm.pages).toBe(1);
  expect(f.calls).toEqual({ playlist: 1, playback: 6, probe: 20 });
  expect(f.reads).toEqual({ getMany: 6 }); expect(f.planBytes).toBe(0);
  if (process.env.MUSICFS_QQ_REFRESH_RESULT) await Bun.write(process.env.MUSICFS_QQ_REFRESH_RESULT,
    JSON.stringify({ scope: 'offline fake QqClient transport, 20 complete single-quality MP3s, shared 32KiB picture; no platform HTTP',
      cold: coldReport, warm: { pages: warm.pages, calls: f.calls, reads: f.reads, planBytes: f.planBytes,
        maxPluginQueries: Math.max(...f.costs.slice(warmStart).map(cost => cost.queries)), maxSourceRequests: Math.max(...f.costs.slice(warmStart).map(cost => cost.requests)) } }, null, 2));
});

test('QQ ready metadata expires with dependencies and fresh catalogue or audio facts invalidate only matching outputs', async () => {
  const f = fixture(6); const cold = await scan(f);
  const expiry = [...f.values].filter(([key]) => key.startsWith('metadata:')).map(([key, value]) => [key, value.expiresAt]);
  const files = cold.items.filter(item => item.kind === 'file');
  expect(files.every(file => !!file.info?.modifiedAt)).toBe(true);
  for (const file of files) {
    const ready = f.values.get(JSON.parse(file.fileRef).readyKey)!;
    expect(ready.expiresAt).toBeLessThanOrEqual(Math.min(...expiry.map(([, value]) => Number(value))));
  }
  f.reset(); f.rename('Changed'); const renamed = await scan(f);
  expect(renamed.items[0]?.name).toContain('Changed'); expect(renamed.items[0]).not.toEqual(cold.items[0]);
  expect(f.calls.lyrics).toBeUndefined();
  expect([...f.values].filter(([key]) => key.startsWith('metadata:')).map(([key, value]) => [key, value.expiresAt])).toEqual(expiry);
  f.reset();
  for (const [key, value] of f.values) if (key.startsWith('ready:') || key.startsWith('metadata:lyrics:')) value.expiresAt = 0;
  const refreshed = await scan(f);
  expect(refreshed.items).toEqual(renamed.items); expect(f.calls.lyrics).toBe(6); expect(f.calls.range).toBeUndefined();
  f.reset(); f.changeAudio(); const changed = await scan(f);
  expect(changed.items[0]).not.toEqual(refreshed.items[0]); expect(f.calls.probe).toBe(6); expect(f.calls.range).toBeGreaterThan(0);
});

test('QQ budgeted preparation and legacy cache retain every occurrence and stable final file information', async () => {
  const worker = fixture(24, { worker: true }); const cold = await scan(worker); const warm = await scan(worker);
  expect(warm.items).toEqual(cold.items); expect(cold.items).toHaveLength(24);
  expect(Math.max(...worker.costs.map(cost => cost.queries))).toBeLessThanOrEqual(32);
  expect(Math.max(...worker.costs.map(cost => cost.requests))).toBeLessThanOrEqual(45);
  const legacy = fixture(6, { legacy: true }); legacy.repeatFirst();
  const first = await scan(legacy); const second = await scan(legacy);
  expect(second.items).toEqual(first.items); expect(first.items).toHaveLength(7); expect(first.pages).toBe(2);
  expect(new Set(first.items.map(item => item.entryId)).size).toBe(7);
  expect(first.items[0]?.kind === 'file' && first.items[1]?.kind === 'file' && first.items[0].fileRef).toBe(first.items[1]?.kind === 'file' && first.items[1].fileRef);
});

test('QQ multiple target qualities retain independent actual files while sharing repeated occurrence work', async () => {
  const f = fixture(6); f.repeatFirst(); f.ctx.config = { audio: { mode: 'multiple', qualities: ['320', '128'], missingQuality: 'hide' } };
  const cold = await scan(f); f.reset(); const warm = await scan(f);
  expect(cold.items).toHaveLength(14); expect(warm.items).toEqual(cold.items); expect(warm.pages).toBe(1);
  expect(new Set(cold.items.map(item => item.entryId)).size).toBe(14);
  expect(f.reads).toEqual({ getMany: 4 }); expect(f.planBytes).toBe(0);
  expect(cold.items.slice(0, 4).map(item => item.name.slice(0, 4))).toEqual(['0001', '0001', '0002', '0002']);
});

test('QQ observes costly CDN fallback before choosing the next block and completes every cold continuation', async () => {
  const f = fixture(12, { worker: true, fallback: true });
  const cold = await scan(f); const warm = await scan(f);
  expect(cold.items).toHaveLength(12); expect(new Set(cold.items.map(item => item.entryId)).size).toBe(12);
  expect(warm.items).toEqual(cold.items); expect(cold.pages).toBeGreaterThan(1);
  expect(Math.max(...f.costs.map(cost => cost.requests))).toBeLessThanOrEqual(45);
  expect(Math.max(...f.costs.map(cost => cost.queries))).toBeLessThanOrEqual(32);
});

test('QQ preserves its accepted prefix when a later CDN path unexpectedly needs the remaining request allowance', async () => {
  const f = fixture(20); const cold = await scan(f); f.reset(); f.slowFrom(10);
  const changedRoute = await scan(f);
  expect(changedRoute.items).toEqual(cold.items); expect(changedRoute.pages).toBeGreaterThan(1);
  expect(Math.max(...f.costs.map(cost => cost.requests))).toBeLessThanOrEqual(45);
});
