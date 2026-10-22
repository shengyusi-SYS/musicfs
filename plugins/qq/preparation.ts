import type { Entry, Page } from '@musicfs/plugin-api';
import type { AudioFormat } from '@musicfs/audio-tags';
import pLimit from 'p-limit';
import { audioPolicy } from './configuration';
import { fail, object, QqRequestBudgetFailure, type QqClient } from './client';
import { decodeFile, resolveVariants, trackKey, type Track } from './playback';
import { formats } from './file-info';
import { MUSIC_FILE_TYPES } from './generated-upstream.mjs';
import { musicTags } from './metadata';
import { sourceReader } from './media';
import { songKey, tagFile, type PreparedFile } from './tagged';

export type Song = Track & { title: string; singer: { name: string }[]; [key: string]: unknown };
export type PreparationPolicy = { warmFiles: number; coldFiles: number; milliseconds: number; concurrency: number };
export const preparation: PreparationPolicy = { warmFiles: 24, coldFiles: 4, milliseconds: 2000, concurrency: 2 };

// Ignore unrelated native availability counters when indexing the exact tagged representation.
function tagFacts(song: Song): Record<string, unknown> {
  const album = object(song.album);
  const pick = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  return { ...pick(song, ['mid', 'title', 'name', 'index_album', 'index_cd', 'time_public']), singer: song.singer.map(({ name }) => ({ name })),
    album: pick(album, ['mid', 'name', 'picUrl', 'singer', 'singers', 'aDate', 'time_public', 'total']) };
}

/** Source-specific preparation; the host owns checkpoints, this module owns work per accepted page. */
export async function preparePage(client: QqClient, songs: Song[], offset: number, policy = preparation): Promise<{ page: Page<Entry>; consumed: number }> {
  const cache = client.ctx.cache; const started = performance.now(); const targets = audioPolicy(client.ctx.config).qualities.length;
  const nativeWidth = Math.max(1, Math.floor(4 / targets));
  const items: Entry[] = [];
  const statistics = { tracks: 0, files: 0, hiddenTracks: 0, missingVersions: 0, fallbackVersions: 0, deduplicatedVersions: 0 };
  const prepared = new Map<string, Promise<PreparedFile>>(); const limit = pLimit(policy.concurrency);
  let consumed = 0; let cold = 0; let largestCost = 0; let resolveCost = 0;
  // The existing QQ transport also caps source requests at 45. Reserve the list RPC already performed.
  let requests = 44; const previousFetch = client.ctx.fetch;
  client.ctx.fetch = ((input, init) => { requests--; return previousFetch(input, init); }) as typeof fetch;
  const remaining = () => Math.min(requests, client.ctx.workBudget?.remaining ?? Infinity);
  try {
    while (consumed < songs.length) {
      if (consumed && remaining() < Math.max(12, largestCost + 2)) break;
      client.ctx.signal.throwIfAborted();
      // Measure an unknown CDN path with one occurrence before batching it. A native
      // resolution can include several failed candidates; reserve preparation work too.
      const affordable = resolveCost ? Math.floor((remaining() - Math.max(8, largestCost + 2)) / resolveCost) : 1;
      if (consumed && affordable < 1) break;
      const coldWidth = cold ? Math.max(1, Math.floor((policy.coldFiles - cold) / targets)) : nativeWidth;
      const width = Math.max(1, Math.min(nativeWidth, affordable, coldWidth));
      const block = songs.slice(consumed, consumed + width);
      const beforeResolution = requests;
      const resolved = await resolveVariants(client, block);
      resolveCost = Math.max(resolveCost, Math.ceil((beforeResolution - requests) / block.length));
      const candidates = await Promise.all(block.map(async (song, index) => {
        const resolution = resolved.get(trackKey(song))!;
        return { song, position: offset + consumed + index, resolution,
          files: await Promise.all(resolution.variants.map(async variant => ({ variant,
            key: await songKey(decodeFile(variant.fileRef), variant.info, tagFacts(song)) }))) };
      }));
      const keys = candidates.flatMap(item => item.files.map(file => file.key));
      if (keys.length && !cache) fail('not_supported', 'QQ 补标签需要支持插件资料缓存的宿主。');
      const saved = !keys.length ? [] : cache!.getMany ? await cache!.getMany(keys) : await Promise.all(keys.map(key => cache!.get(key)));
      const ready = new Map(keys.map((key, index) => {
        const file = saved[index] as unknown as PreparedFile | undefined;
        return [key, client.ctx.metadataRefresh && file?.metadataRefreshId !== client.ctx.metadataRefresh ? undefined : file];
      }));
      for (let start = 0; start < candidates.length;) {
        const width = client.ctx.workBudget ? 1 : policy.concurrency;
        const chunk = candidates.slice(start, start + width);
        const hasCold = chunk.some(item => item.files.some(file => !ready.get(file.key) && !prepared.has(file.key)));
        if (consumed && hasCold && remaining() < Math.max(12, largestCost + 2)) return { page: { items, statistics }, consumed };
        const before = remaining(); let failure: unknown;
        const work = chunk.map(item => limit(async () => {
          if (failure) throw failure;
          try {
            const files: Entry[] = [];
            for (const candidate of item.files) {
              let file = ready.get(candidate.key);
              if (!file) {
                let pending = prepared.get(candidate.key);
                if (!pending) {
                  cold++;
                  pending = (async () => {
                    const material = await musicTags(client, item.song,
                      chunk.length === 1 && !client.ctx.workBudget && policy.concurrency >= 2 ? 2 : 1);
                    const variant = candidate.variant;
                    return tagFile(client, decodeFile(variant.fileRef), variant.info,
                      MUSIC_FILE_TYPES[variant.quality].extension.slice(1) as AudioFormat, material.tags,
                      sourceReader(client, variant.fileRef, variant.info, variant.location), { key: candidate.key, expiresAt: material.expiresAt });
                  })();
                  prepared.set(candidate.key, pending);
                }
                file = await pending;
              }
              const album = object(item.song.album); const albumArtists = album.singer ?? album.singers;
              const albumArtist = Array.isArray(albumArtists) ? albumArtists.map(value => object(value).name ?? object(value).singername)
                .filter((value): value is string => typeof value === 'string' && !!value) : [];
              const positive = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
              const track = positive(item.song.index_album); const disc = positive(item.song.index_cd);
              files.push({ kind: 'file', entryId: `${item.position}:${item.song.mid}:${candidate.variant.quality}`,
                name: `${String(item.position + 1).padStart(4, '0')} - ${item.song.title} - ${item.song.singer.map(artist => artist.name).join('、')} [${formats[candidate.variant.quality].label}]${MUSIC_FILE_TYPES[candidate.variant.quality].extension}`,
                naming: { identity: JSON.stringify([item.song.mid, candidate.variant.quality]), fields: { title: item.song.title,
                  artist: item.song.singer.map(artist => artist.name), ...(typeof album.name === 'string' && album.name ? { album: album.name } : {}),
                  ...(albumArtist.length ? { albumArtist } : {}), ...(track === undefined ? {} : { track }), ...(disc === undefined ? {} : { disc }),
                  index: item.position + 1, quality: formats[candidate.variant.quality].label, id: item.song.mid } },
                fileRef: file.fileRef, info: file.info });
            }
            return files;
          } catch (error) { failure ??= error; throw error; }
        }));
        const outcomes = await Promise.allSettled(work);
        if (failure) throw failure;
        largestCost = Math.max(largestCost, before - remaining());
        for (let i = 0; i < chunk.length; i++) {
          const outcome = outcomes[i]!; if (outcome.status === 'rejected') throw outcome.reason;
          const item = chunk[i]!; items.push(...outcome.value); consumed++; statistics.tracks++;
          if (!item.files.length) statistics.hiddenTracks++;
          statistics.missingVersions += item.resolution.missingVersions; statistics.fallbackVersions += item.resolution.fallbackVersions;
          statistics.deduplicatedVersions += item.resolution.deduplicatedVersions;
        }
        start += chunk.length; statistics.files = items.length;
        if (cold >= policy.coldFiles || cold > 0 && performance.now() - started >= policy.milliseconds) return { page: { items, statistics }, consumed };
      }
    }
    return { page: { items, statistics }, consumed };
  } catch (error) {
    // A later track can need more CDN candidates than earlier samples. Keep the
    // accepted prefix; a new invocation remeasures that unaccepted occurrence.
    if (error instanceof QqRequestBudgetFailure && consumed) return { page: { items, statistics }, consumed };
    throw error;
  } finally { client.ctx.fetch = previousFetch; }
}
