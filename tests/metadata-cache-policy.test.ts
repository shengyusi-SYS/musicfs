import { expect, test } from 'bun:test';
import Ajv from 'ajv';
import type { Context, Json } from '@musicfs/plugin-api';
import neteaseSchema from '../plugins/netease/config.schema.json';
import qqSchema from '../plugins/qq/config.schema.json';
import { metadataCacheExpiry as neteaseExpiry, normalizeConfig as normalizeNetease, migrateConfig as migrateNetease } from '../plugins/netease/configuration';
import { metadataCacheExpiry as qqExpiry, normalizeConfig as normalizeQq, migrateConfig as migrateQq } from '../plugins/qq/configuration';
import { NeteaseFailure, type NeteaseClient } from '../plugins/netease/client';
import type { QqClient } from '../plugins/qq/client';
import { endpoints } from '../plugins/netease/generated-upstream.mjs';
import { musicTags as neteaseTags } from '../plugins/netease/metadata';
import { musicTags as qqTags } from '../plugins/qq/metadata';
import { tagFile as neteaseTagFile } from '../plugins/netease/tagged';
import { tagFile as qqTagFile } from '../plugins/qq/tagged';
import { cover, fixture as audioFixture } from '../packages/audio-tags/test-fixtures';
import { memoryCache } from './helpers/source-metadata';
import neteasePlugin from '../plugins/netease';
import qqPlugin from '../plugins/qq';
import neteaseManifest from '../plugins/netease/manifest.json';
import qqManifest from '../plugins/qq/manifest.json';
import { parseManifest } from '../src/core/extensions';
import { preparePluginMigration } from '../src/core/sources/migration';

const day = 24 * 60 * 60_000;

test('plugin config migration upgrades old defaults once while preserving other periods and audio settings', () => {
  for (const [migrate, normalize, legacy] of [[migrateNetease, normalizeNetease, 7], [migrateQq, normalizeQq, 1]] as const) {
    expect(migrate({ fromVersion: 1, config: { metadataCacheDays: legacy } })).toEqual(normalize({}));
    for (const days of [0, 30, 90]) expect(migrate({ fromVersion: 1, config: { metadataCacheDays: days } })).toMatchObject({ metadataCacheDays: days });
    expect(normalize({ metadataCacheDays: legacy })).toMatchObject({ metadataCacheDays: legacy });
  }
});

test('both real plugin migration hooks preserve their existing private session without platform requests', async () => {
  const signal = new AbortController().signal;
  const noFetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    throw new Error('Cache default migration must not access the platform');
  }) as unknown as typeof fetch;
  for (const [plugin, manifest, oldDefault] of [[neteasePlugin, neteaseManifest, 7], [qqPlugin, qqManifest, 1]] as const) {
    const config = { metadataCacheDays: oldDefault };
    const created = await plugin.validateConfig({ instanceId: 'cache-migration', config, privateState: null, signal, fetch: noFetch }, config);
    if (!created.ok || !created.nextPrivateState) throw new Error('Offline session fixture initialization failed');
    const target = parseManifest(manifest, 'desktop');
    const previous = { ...target, configVersion: 1 };
    const result = await preparePluginMigration(previous, target, plugin, { id: 'cache-migration', pluginId: target.id,
      name: 'Saved', config: created.value, privateState: created.nextPrivateState, epoch: 1, stateRevision: 1 }, signal, noFetch);
    expect(result.privateState).toEqual(created.nextPrivateState);
    expect(result.config).not.toHaveProperty('metadataCacheDays');
  }
});
function fixture(provider: 'NetEase' | 'QQ', config: Json, missing = false) {
  const cache = memoryCache(); let requests = 0;
  const ctx: Context = { instanceId: 'metadata-policy-offline', config, privateState: null, signal: new AbortController().signal, cache,
    fetch: (async input => {
      requests++; const url = new URL(String(input));
      if (url.hostname === 'c.y.qq.com') {
        if (missing) return new Response(null, { status: 404 });
        return Response.json(url.pathname.includes('/lyric/')
          ? { code: 0, lyric: '[00:00.00]原文', trans: '[00:00.00]Translation', roma: '[00:00.00]Romanization' }
          : { code: 0, data: { singer: [{ name: 'Album artist' }], aDate: '2020-01-01' } });
      }
      return missing ? new Response(null, { status: 404 }) : new Response(cover, { headers: { 'Content-Type': 'image/png' } });
    }) as typeof fetch };
  const netease = () => ({ ctx, requireSession() {}, async call(endpoint: unknown) {
    requests++;
    if (endpoint === endpoints.lyric) return missing ? {} : { lrc: { lyric: '[00:00.00]原文' }, tlyric: { lyric: '[00:00.00]Translation' } };
    if (endpoint === endpoints.album) {
      if (missing) throw new NeteaseFailure({ kind: 'not_found', message: 'Missing offline album' });
      return { album: { artists: [{ name: 'Album artist' }], publishTime: 1577836800000 } };
    }
    throw new Error('Unexpected offline NetEase call');
  } }) as unknown as NeteaseClient;
  const qq = () => ({ ctx, requireSession() {}, async rpc(describe: () => { module: string }) {
    requests++; const operation = describe();
    if (operation.module === 'music.pf_song_detail_svr') return missing ? {} : { track_info: { index_album: 1, index_cd: 1 } };
    if (operation.module === 'music.musichallSong.PlayLyricInfo') return {};
    throw new Error('Unexpected offline QQ RPC');
  } }) as unknown as QqClient;
  return { cache, get requests() { return requests; },
    read: () => provider === 'NetEase'
      ? neteaseTags(netease(), { id: 1, name: 'Source title', ar: [{ name: 'Artist' }], al: { id: 10, name: 'Source album', picUrl: 'https://p1.music.126.net/cover.png' } })
      : qqTags(qq(), { mid: 'one', title: 'Source title', singer: [{ name: 'Artist' }], album: { mid: 'album', name: 'Source album', picUrl: 'https://y.gtimg.cn/cover.png' } }),
    async prepareReady(material: Awaited<ReturnType<typeof neteaseTags>>) {
      const audio = audioFixture('mp3'); const ready = { key: 'ready:cache-policy', expiresAt: material.expiresAt };
      if (provider === 'NetEase') await neteaseTagFile(netease(), { version: 1, id: '1', level: 'standard', type: 'mp3', md5: '0'.repeat(32), size: audio.bytes.length }, audio.info, 'mp3', material.tags, audio.readRange, ready);
      else await qqTagFile(qq(), { version: 1, mid: 'one', mediaId: 'one', quality: '128', filename: 'M500one.mp3' }, audio.info, 'mp3', material.tags, audio.readRange, ready);
    },
    expire() { for (const saved of cache.values.values()) if (saved.expiresAt !== undefined) saved.expiresAt = 0; },
  };
}

test('metadata defaults retain stable data for a year and preserve explicit shorter policies', () => {
  expect(normalizeNetease({ metadataCacheDays: 365 })).toEqual(normalizeNetease({}));
  expect(normalizeQq({ metadataCacheDays: 365 })).toEqual(normalizeQq({}));
  const validator = new Ajv();
  for (const [schema, normalize, expiry, defaults] of [[neteaseSchema, normalizeNetease, neteaseExpiry, 365], [qqSchema, normalizeQq, qqExpiry, 365]] as const) {
    const validate = validator.compile(schema);
    for (const days of [0, 1, 7, 30, 365]) expect(validate(normalize({ metadataCacheDays: days }))).toBe(true);
    for (const days of [-1, 0.5, '0']) expect(validate(normalize({ metadataCacheDays: days }))).toBe(false);
    expect(normalize({})).not.toHaveProperty('metadataCacheDays'); expect(expiry({}, 1000)).toBe(1000 + defaults * day); expect(expiry({ metadataCacheDays: 0 }, 1000)).toBeNull();
  }
});

for (const provider of ['NetEase', 'QQ'] as const) {
  test(`${provider}: successful metadata and ready indexes can persist without expiry across invocations`, async () => {
    const f = fixture(provider, { metadataCacheDays: 0 }); const first = await f.read(); const requests = f.requests;
    expect(first.expiresAt).toBeNull(); expect(first.tags.title).toBe('Source title'); expect(first.tags.album).toBe('Source album');
    for (const saved of f.cache.values.values()) { expect(saved.expiresAt).toBeUndefined(); expect((saved.value as { expiresAt: Json }).expiresAt).toBeNull(); }
    expect(await f.read()).toEqual(first); expect(f.requests).toBe(requests);
    await f.prepareReady(first); expect(f.cache.values.get('ready:cache-policy')?.expiresAt).toBeUndefined();
  });

  test(`${provider}: finite metadata expires, while missing results stay retryable after one month under permanent policy`, async () => {
    const f = fixture(provider, { metadataCacheDays: 3 }); const before = Date.now(); const first = await f.read(); const requests = f.requests;
    expect(first.expiresAt).toBeGreaterThanOrEqual(before + 3 * day); expect(first.expiresAt).toBeLessThanOrEqual(Date.now() + 3 * day);
    await f.read(); expect(f.requests).toBe(requests); f.expire(); await f.read(); expect(f.requests).toBeGreaterThan(requests);
    const missing = fixture(provider, { metadataCacheDays: 0 }, true); const absent = await missing.read(); const missingRequests = missing.requests;
    expect(absent.tags.title).toBe('Source title'); expect(absent.tags.album).toBe('Source album'); expect(absent.tags.cover).toBeUndefined(); expect(absent.tags.lyrics).toBeUndefined();
    expect(absent.expiresAt).toBeGreaterThanOrEqual(before + 30 * day); expect(absent.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * day);
    for (const saved of missing.cache.values.values()) expect(saved.expiresAt).toBeGreaterThan(before);
    await missing.read(); expect(missing.requests).toBe(missingRequests); missing.expire(); await missing.read(); expect(missing.requests).toBeGreaterThan(missingRequests);
  });
}
