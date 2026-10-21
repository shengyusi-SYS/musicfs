import { mediaFor, memoryCache, metadataFetch, qqTrackFields } from './helpers/source-metadata';
import { expect, test } from 'bun:test';
import type { Context, Entry, Json, Outcome } from '@musicfs/plugin-api';
import { createQqPlugin } from '../plugins/qq';
import { qqSession } from './helpers/qq-session';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const value = <T>(result: Outcome<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
const song = (mid: string, size_ape: unknown = 0) => ({ ...qqTrackFields, mid, title: '歌曲', singer: [{ name: '歌手' }], file: { media_mid: `media${mid}`, size_ape } });
const audio = (qualities: string[], missingQuality = 'hide', mode = qualities.length > 1 ? 'multiple' : 'single'): Json => ({ audio: { mode, qualities, missingQuality } });
const files = (items: Entry[]) => items.map(item => { if (item.kind !== 'file') throw new Error('Expected file'); return (JSON.parse(item.fileRef).source ?? JSON.parse(item.fileRef)) as { version: number; mid: string; mediaId: string; quality: string; filename: string }; });
async function fixture() {
  let songs = [song('a'), song('b'), song('a')]; const available = new Set(['M800amediaa.mp3']);
  let malformed = false; let code = 0; let status = 200; let preview = false; let actualFilename: string | undefined;
  let apeDetail: unknown = { file: { size_ape: 0 } };
  const mediaCalls: string[] = [];
  const calls: { method: string; filenames: string[]; cookie: string | null }[] = [];
  const fetcher = (async (input, init) => {
    if (!init?.body) { mediaCalls.push(String(input)); const bytes = mediaFor(String(input)); const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')!; const start = Number(range[1]); const end = Number(range[2]); return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1), ETag: '"fixture-file"' } }); }
    const request = JSON.parse(String(init?.body)); const response: Record<string, unknown> = { code: 0 };
    for (const [key, raw] of Object.entries(request)) {
      if (!key.startsWith('req_')) continue;
      const rpc = raw as { method: string; param: { filename?: string[]; songmid?: string[] } };
      const filenames = rpc.param.filename ?? []; calls.push({ method: rpc.method, filenames, cookie: new Headers(init?.headers).get('cookie') });
      if (rpc.method === 'uniform_get_Dissinfo') { response[key] = { code: 0, data: { songlist: songs } }; continue; }
      if (rpc.method === 'get_song_detail_yqq') { response[key] = { code, data: { track_info: apeDetail } }; continue; }
      response[key] = { code, data: malformed ? {} : { sip: [], midurlinfo: filenames.map((filename, index) => ({ filename, songmid: rpc.param.songmid![index],
        purl: available.has(filename) ? `${preview ? 'RS02preview.mp3' : actualFilename ?? filename}?vkey=private` : '', result: available.has(filename) ? 0 : 104003 })) } };
    }
    return json(response, status);
  }) as typeof fetch;
  const plugin = createQqPlugin(async request => new URL(request.url).pathname === '/user/daily-songs' ? json({ songs }) : json({}, 404));
  const ctx: Context = { instanceId: 'quality-fixture', config: audio(['flac', '320'], 'fallback'), privateState: await qqSession(), signal: new AbortController().signal, fetch: metadataFetch(fetcher), cache: memoryCache() };
  return { plugin, ctx, calls, mediaCalls, available, setSongs(next: ReturnType<typeof song>[]) { songs = next; }, setMalformed() { malformed = true; }, setCode(next: number) { code = next; }, setStatus(next: number) { status = next; }, setPreview() { preview = true; },
    setApeDetail(value: unknown) { apeDetail = value; }, setActual(filename: string) { actualFilename = filename; } };
}

test('QQ validates per-instance single/multiple quality settings and supplies compatible defaults', async () => {
  const f = await fixture(); const defaulted = value(await f.plugin.validateConfig(f.ctx, {}));
  expect(defaulted).toMatchObject({ audio: { mode: 'single', qualities: ['128'], missingQuality: 'hide' } });
  for (const invalid of [audio(['flac', '320'], 'hide', 'single'), audio([]), audio(['128', '128']), audio(['preview']), audio(['128'], 'ignore')]) {
    expect(await f.plugin.validateConfig(f.ctx, invalid)).toMatchObject({ ok: false, error: { kind: 'invalid_config' } });
  }
  expect(await f.plugin.validateConfig(f.ctx, audio(['flac', 'ape', '320', '128', 'm4a']))).toMatchObject({ ok: true });
});

test('QQ default configuration arrays belong to each validated instance', async () => {
  const f = await fixture(); const first = value(await f.plugin.validateConfig(f.ctx, {})) as { audio: { qualities: string[] } };
  first.audio.qualities.push('320');
  expect(value(await f.plugin.validateConfig(f.ctx, {}))).toMatchObject({ audio: { qualities: ['128'] } });
});

test('QQ fallback labels actual files, merges identical variants and retains repeated playlist occurrences', async () => {
  const f = await fixture(); const result = { items: [] as Entry[], statistics: {} as Record<string, number> }; let cursor: string | undefined;
  do {
    const page = value(await f.plugin.list(f.ctx, 'daily', cursor)); cursor = page.nextCursor; result.items.push(...page.items);
    for (const [key, count] of Object.entries(page.statistics!)) result.statistics[key] = (result.statistics[key] ?? 0) + count;
  } while (cursor);
  expect(result.items.map(item => item.name)).toEqual(['0001 - 歌曲 - 歌手 [320k].mp3', '0003 - 歌曲 - 歌手 [320k].mp3']);
  expect(files(result.items).map(item => item.quality)).toEqual(['320', '320']);
  expect(result.statistics).toMatchObject({ tracks: 3, files: 2, hiddenTracks: 1, fallbackVersions: 2, deduplicatedVersions: 2 });
  const filenames = f.calls.flatMap(call => call.filenames); expect(filenames.filter(name => name === 'M800amediaa.mp3').length).toBeLessThanOrEqual(2);
  expect(f.mediaCalls.length).toBeLessThan(8); // Repeated occurrences reuse the immutable plan instead of preparing tags again.
  expect(result.items.every(item => item.kind === 'file' && (item.info?.size ?? 0) > 123)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('vkey');
});

test('QQ hides missing selected qualities and preserves distinct actual encodings', async () => {
  const f = await fixture(); f.setSongs([song('a')]); f.ctx.config = audio(['flac', '320']);
  expect(files(value(await f.plugin.list(f.ctx, 'daily')).items).map(item => item.quality)).toEqual(['320']);
  f.available.add('F000amediaa.flac');
  expect(files(value(await f.plugin.list(f.ctx, 'daily')).items).map(item => item.quality)).toEqual(['flac', '320']);
  f.ctx.config = audio(['flac'], 'fallback'); f.available.delete('F000amediaa.flac');
  expect(files(value(await f.plugin.list(f.ctx, 'daily')).items)).toEqual([{ version: 1, mid: 'a', mediaId: 'mediaa', quality: '320', filename: 'M800amediaa.mp3' }]);
});

test('QQ excludes preview files and fails transient/auth/rate-limit errors without hiding them through fallback', async () => {
  const f = await fixture(); f.setSongs([song('a')]); f.setPreview();
  expect(value(await f.plugin.list(f.ctx, 'daily')).items).toEqual([]);
  for (const mode of ['malformed', 'auth', 'limited', 'network'] as const) {
    const g = await fixture();
    if (mode === 'malformed') g.setMalformed(); else if (mode === 'auth') g.setCode(104400); else g.setStatus(mode === 'limited' ? 429 : 503);
    expect(await g.plugin.list(g.ctx, 'daily')).toMatchObject({ ok: false, error: { kind: mode === 'auth' ? 'needs_auth' : mode === 'limited' ? 'rate_limited' : 'temporary' } });
    expect(g.calls.filter(call => call.method === 'UrlGetVkey').length).toBeLessThanOrEqual(2); // No fallback batch ran; collection errors may fail first.
  }
});

test('QQ verifies APE existence through SDK rules and keeps unknown file metadata distinct from a missing version', async () => {
  const f = await fixture(); f.ctx.config = audio(['ape']); f.setSongs([song('a', 0)]); f.available.add('A000amediaa.ape');
  expect(value(await f.plugin.list(f.ctx, 'daily')).items).toEqual([]); expect(f.calls.filter(call => call.method === 'UrlGetVkey')).toEqual([]);
  f.setSongs([song('a', 100)]);
  expect(files(value(await f.plugin.list(f.ctx, 'daily')).items)[0]?.quality).toBe('ape');
  f.setSongs([song('a', null)]); f.setApeDetail(null);
  expect(await f.plugin.list(f.ctx, 'daily')).toMatchObject({ ok: false, error: { kind: 'temporary' } });
  f.setApeDetail({ file: { size_ape: '200' } });
  expect(files(value(await f.plugin.list(f.ctx, 'daily')).items)[0]?.quality).toBe('ape');
});

test('QQ obeys the configured fallback policy when the upstream itself returns a lower actual encoding', async () => {
  const f = await fixture(); f.setSongs([song('a')]); f.available.add('F000amediaa.flac'); f.setActual('M800amediaa.mp3');
  f.ctx.config = audio(['flac']); expect(value(await f.plugin.list(f.ctx, 'daily')).items).toEqual([]);
  f.ctx.config = audio(['flac'], 'fallback');
  expect(value(await f.plugin.list(f.ctx, 'daily')).items[0]?.name).toContain('[320k].mp3');
});

test('QQ accepts the observed canonical media-only filename while retaining the requested song association', async () => {
  const f = await fixture(); f.setSongs([song('a')]); f.ctx.config = audio(['320']); f.setActual('M800mediaa.mp3');
  expect(files(value(await f.plugin.list(f.ctx, 'daily')).items)[0]?.filename).toBe('M800mediaa.mp3');
  f.setActual('M800unrelated.mp3');
  expect(await f.plugin.list(f.ctx, 'daily')).toMatchObject({ ok: false, error: { kind: 'content_changed' } });
});

test('QQ batches distinct media identities and never lets one instance quality setting affect another', async () => {
  const f = await fixture(); f.setSongs(Array.from({ length: 9 }, (_, index) => song('s' + index))); f.ctx.config = audio(['128']);
  let cursor: string | undefined; let tracks = 0; let pages = 0;
  do { const result = value(await f.plugin.list(f.ctx, 'daily', cursor)); tracks += result.statistics!.tracks!; pages++; cursor = result.nextCursor; } while (cursor);
  expect(tracks).toBe(9); expect(pages).toBe(1);
  expect(f.calls.filter(call => call.method === 'UrlGetVkey').every(call => call.filenames.length <= 4)).toBe(true);
  expect(f.calls.flatMap(call => call.filenames)).toContain('M500s8medias8.mp3');
  const g = await fixture(); g.setSongs([song('a')]); g.ctx.config = audio(['320']);
  expect(files(value(await g.plugin.list(g.ctx, 'daily')).items)[0]?.quality).toBe('320');
  expect(f.ctx.config).toEqual(audio(['128']));
});
