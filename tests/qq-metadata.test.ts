import { mediaFor, memoryCache, metadataFetch, qqTrackFields } from './helpers/source-metadata';
import { expect, test } from 'bun:test';
import type { Context, Entry, Outcome, Page } from '@musicfs/plugin-api';
import { createQqPlugin } from '../plugins/qq';
import { qqSession } from './helpers/qq-session';

const value = <T>(outcome: Outcome<T>): T => { if (!outcome.ok) throw new Error(outcome.error.message); return outcome.value; };
const song = (mid: string) => ({ ...qqTrackFields, mid, title: '歌曲', singer: [{ name: '歌手' }], file: { media_mid: `media${mid}`, size_ape: 100 } });
const file = (item: Entry | undefined) => { if (item?.kind !== 'file') throw new Error('Expected file'); return item; };
const json = (body: unknown) => new Response(JSON.stringify(body));

async function fixture() {
  let songs = Array.from({ length: 8 }, (_, index) => song(`s${index}`));
  let fallbackCdn = false; let missingValidator = false; let redirects = false;
  const requests: { kind: string; url: string; filenames: string[]; offset: number; redirect: RequestRedirect | undefined }[] = [];
  const fetcher = (async (input, init) => {
    const url = new URL(String(input));
    if (init?.body) {
      const body = JSON.parse(String(init.body)); const response: Record<string, unknown> = { code: 0 };
      for (const [key, raw] of Object.entries(body)) if (key.startsWith('req_')) {
        const rpc = raw as { method: string; param: { dirid?: number; song_begin?: number; song_num?: number; filename?: string[]; songmid?: string[] } };
        requests.push({ kind: rpc.method, url: url.href, filenames: rpc.param.filename ?? [], offset: rpc.param.song_begin ?? 0, redirect: init.redirect });
        let data: unknown;
        if (rpc.method === 'uniform_get_Dissinfo') data = { songlist: songs };
        else if (rpc.method === 'CgiGetDiss') {
          const offset = rpc.param.song_begin!;
          data = { songlist: songs.slice(offset, offset + rpc.param.song_num!), total_song_num: songs.length, hasmore: 1 };
        } else if (rpc.method === 'GetCdnDispatch') data = { sip: [1, 2, 3, 4].map(index => `https://d${index}.stream.qqmusic.qq.com/`) };
        else if (rpc.method === 'UrlGetVkey') data = { sip: fallbackCdn ? [1, 2, 3, 4].map(index => `https://s${index}.stream.qqmusic.qq.com/`) : ['https://s1.stream.qqmusic.qq.com/'],
          midurlinfo: rpc.param.filename!.map((filename, index) => ({ filename, songmid: rpc.param.songmid![index], purl: `${filename}?vkey=private` })) };
        else throw new Error(`Unexpected SDK descriptor ${rpc.method}`);
        response[key] = { code: 0, data };
      }
      return json(response);
    }
    requests.push({ kind: 'CDN', url: url.href, filenames: [], offset: 0, redirect: init?.redirect });
    expect(init?.redirect).toBe('manual');
    if (redirects) return new Response(null, { status: 302, headers: { Location: 'https://unfollowed.qqmusic.qq.com/redirect' } });
    if (fallbackCdn && url.hostname !== 'dl.stream.qqmusic.qq.com') return new Response(null, { status: 503 });
    const bytes = mediaFor(url.href); const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')!; const start = Number(range[1]); const end = Number(range[2]);
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1),
      ...(missingValidator ? {} : { ETag: '"real-fixture-version"' }) } });
  }) as typeof fetch;
  const plugin = createQqPlugin(async () => { throw new Error('Catalogue reads must not use the global-fetch HTTP facade'); });
  const ctx: Context = { instanceId: 'metadata-a', config: {}, privateState: await qqSession(), signal: new AbortController().signal, fetch: metadataFetch(fetcher), cache: memoryCache() };
  return { plugin, ctx, requests, setSongs(next: ReturnType<typeof song>[]) { songs = next; }, useFallbackCdn() { fallbackCdn = true; },
    removeValidator() { missingValidator = true; }, redirectCdn() { redirects = true; } };
}

test('QQ small pages carry real info, preserve the complete daily sequence and accumulate occurrence statistics', async () => {
  const f = await fixture();
  const first = value(await f.plugin.list(f.ctx, 'daily')); const last = value(await f.plugin.list(f.ctx, 'daily', first.nextCursor));
  expect(first.statistics).toMatchObject({ tracks: 4, files: 4 }); expect(last.statistics).toMatchObject({ tracks: 4, files: 4 });
  expect(last.nextCursor).toBeUndefined();
  expect([...first.items, ...last.items].map(item => item.name.slice(0, 4))).toEqual(['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008']);
  expect([...first.items, ...last.items].every(item => (file(item).info?.size ?? 0) > 123)).toBe(true);
  expect(file(first.items[0]).info).toMatchObject({ mediaType: 'audio/mpeg' }); expect(file(first.items[0]).info?.contentId).toStartWith('audio-tags-v1:');
  expect(f.requests.filter(request => request.kind === 'uniform_get_Dissinfo')).toHaveLength(1);
  const playbackBatches = f.requests.filter(request => request.kind === 'UrlGetVkey').map(request => request.filenames);
  expect(playbackBatches.flat()).toHaveLength(8); // Tag ranges reuse each list-resolved locator.
  expect(playbackBatches.every(batch => batch.length > 0 && batch.length <= 4)).toBe(true);
  expect(JSON.stringify([first, last])).not.toContain('private');
  expect(JSON.parse(first.nextCursor!)).toMatchObject({ instanceId: f.ctx.instanceId, directory: 'daily', offset: 4, total: 8 });
});

test('QQ daily cursors retain the cached recommendation snapshot and reject another instance', async () => {
  const f = await fixture(); const first = value(await f.plugin.list(f.ctx, 'daily'));
  let before = f.requests.length;
  expect(await f.plugin.list({ ...f.ctx, instanceId: 'metadata-b' }, 'daily', first.nextCursor)).toMatchObject({ ok: false, error: { kind: 'not_found' } });
  expect(f.requests).toHaveLength(before);
  f.setSongs(Array.from({ length: 8 }, (_, index) => song(`changed${index}`)));
  const next = value(await f.plugin.list(f.ctx, 'daily', first.nextCursor)); expect(next.items[0]!.name).toStartWith('0005');
  expect(f.requests.slice(before).some(request => request.kind === 'uniform_get_Dissinfo')).toBe(false);
});

test('QQ five target qualities fit one occurrence per page, retain every position and reuse metadata for stat', async () => {
  const f = await fixture(); f.setSongs([song('a'), song('a')]);
  f.ctx.config = { audio: { mode: 'multiple', qualities: ['flac', 'ape', '320', '128', 'm4a'], missingQuality: 'hide' } };
  const pages: Page<Entry>[] = []; let cursor: string | undefined;
  do { const page = value(await f.plugin.list(f.ctx, 'daily', cursor)); pages.push(page); cursor = page.nextCursor; } while (cursor);
  expect(pages.map(page => page.statistics?.tracks)).toEqual([1, 1]); expect(pages.map(page => page.items.length)).toEqual([5, 5]);
  expect(pages.flatMap(page => page.items).map(item => item.name.slice(0, 4))).toEqual([...Array(5).fill('0001'), ...Array(5).fill('0002')]);
  expect(pages[0]!.items.map(item => file(item).info?.mediaType)).toEqual(['audio/flac', 'audio/x-ape', 'audio/mpeg', 'audio/mpeg', 'audio/mp4']);
  const entry = file(pages[0]!.items[0]); const before = f.requests.length;
  if (!entry.info) throw new Error('Expected prepared metadata');
  expect(value(await f.plugin.stat(f.ctx, entry.fileRef))).toEqual(entry.info);
  expect(f.requests.slice(before)).toEqual([]);
});

test('QQ keeps CDN fallback bounded and checkpoints before exhausting a larger cold page', async () => {
  const f = await fixture(); f.useFallbackCdn(); f.setSongs([song('s0')]);
  const smaller = value(await f.plugin.list(f.ctx, 'daily'));
  expect(smaller.items).toHaveLength(1);
  expect(f.requests.filter(request => request.kind === 'CDN').length).toBeGreaterThanOrEqual(9); // Keep the existing fallback candidate strategy.
  f.setSongs(Array.from({ length: 6 }, (_, index) => song(`s${index}`)));
  const before = f.requests.length;
  let page = value(await f.plugin.list(f.ctx, 'daily')); const entries = [...page.items];
  expect(page.nextCursor).toBeDefined();
  expect(f.requests.length - before).toBeLessThanOrEqual(45);
  while (page.nextCursor) {
    const start = f.requests.length; page = value(await f.plugin.list(f.ctx, 'daily', page.nextCursor)); entries.push(...page.items);
    expect(f.requests.length - start).toBeLessThanOrEqual(45);
  }
  expect(entries).toHaveLength(6); expect(new Set(entries.map(item => item.entryId)).size).toBe(6);
  // Each continuation owns its request counter; a small independent directory still works.
  f.setSongs([song('small')]); expect(value(await f.plugin.list(f.ctx, 'daily')).statistics).toMatchObject({ tracks: 1, files: 1, hiddenTracks: 0 });
});

test('QQ metadata preparation refuses missing validators and does not follow CDN redirects', async () => {
  const f = await fixture(); f.setSongs([song('a')]); f.removeValidator();
  expect(await f.plugin.list(f.ctx, 'daily')).toMatchObject({ ok: false, error: { kind: 'not_supported' } });
  const g = await fixture(); g.setSongs([song('a')]); g.redirectCdn();
  expect(await g.plugin.list(g.ctx, 'daily')).toMatchObject({ ok: false, error: { kind: 'temporary' } });
  expect(g.requests.filter(request => request.kind === 'CDN').every(request => request.redirect === 'manual')).toBe(true);
  expect(g.requests.some(request => request.url.includes('unfollowed'))).toBe(false);
});
