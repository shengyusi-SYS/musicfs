import type { FileInfo, Json, ReadRequest, ReadResult } from '@musicfs/plugin-api';
import { AudioReservationError, open, prepare, type AudioFormat, type AudioTags, type ReadRange, type TaggedPlan } from '@musicfs/audio-tags';
import { z } from 'zod';
import { fail, type NeteaseClient } from './client';
import { decodeFile, info, type MediaReference } from './reference';
import { musicTags } from './metadata';
import { packPlan, unpackPlan, type StoredPlan } from './plan-storage';

const reference = z.discriminatedUnion('version', [
  z.object({ version: z.literal(2), source: z.unknown(), planKey: z.string().min(1) }).strict(),
  z.object({ version: z.literal(3), source: z.unknown(), descriptorKey: z.string().regex(/^tag-seed:[a-f0-9]{64}$/) }).strict(),
  z.object({ version: z.literal(4), source: z.unknown(), descriptorKey: z.string().regex(/^tag-seed:[a-f0-9]{64}$/),
    generation: z.string().min(1), modifiedAt: z.string().min(1) }).strict(),
]);
type ReservedReference = { version: 4; source: MediaReference; descriptorKey: string; generation: string; modifiedAt: string };
type Reference = { version: 2; source: MediaReference; planKey: string } | { version: 3; source: MediaReference; descriptorKey: string } | ReservedReference;
const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
const byteHash = async (value: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value))), byte => byte.toString(16).padStart(2, '0')).join('');

export function decodeTagged(file: string): Reference | undefined {
  let raw: unknown; try { raw = JSON.parse(file); } catch { return; }
  const version = (raw as { version?: unknown } | null)?.version;
  if (version !== 2 && version !== 3 && version !== 4) return;
  const parsed = reference.safeParse(raw);
  if (!parsed.success) fail('not_found', '网易云补标签文件引用无效。');
  return { ...parsed.data, source: decodeFile(JSON.stringify(parsed.data.source)) };
}

async function plan(client: NeteaseClient, planKey: string): Promise<StoredPlan> {
  client.requireSession();
  if (!client.ctx.cache) fail('not_supported', '网易云补标签需要支持插件资料缓存的宿主。');
  const saved = await client.ctx.cache.get(planKey);
  if (saved === undefined || saved === null) fail('temporary', '网易云补标签文件资料已丢失，请重新刷新目录。');
  return saved as unknown as StoredPlan;
}

const sharedAssets = new WeakMap<NeteaseClient, Set<string>>();

export async function tagFile(client: NeteaseClient, source: MediaReference, sourceInfo: FileInfo, format: AudioFormat, tags: AudioTags, readRange: ReadRange,
  ready?: { key: string; expiresAt: number | null }) {
  const cache = client.ctx.cache;
  if (!cache) fail('not_supported', '网易云补标签需要支持插件资料缓存的宿主。');
  const picture = tags.cover ? { data: tags.cover.data, digest: await byteHash(tags.cover.data) } : undefined;
  const tagIdentity = tags.cover ? { ...tags, cover: { mimeType: tags.cover.mimeType, description: tags.cover.description, digest: picture!.digest } } : tags;
  const inputKey = `tag-input:${await hash([source, sourceInfo, tagIdentity])}`;
  const previous = await cache.get(inputKey);
  if (typeof previous === 'string') {
    const saved = await cache.get(previous);
    if (saved !== undefined && saved !== null) {
      const file = { fileRef: JSON.stringify({ version: 2, source, planKey: previous }), info: (saved as unknown as TaggedPlan).content };
      if (ready) {
        if (cache.putMany) await cache.putMany(readyWrites(ready, file));
        else for (const item of readyWrites(ready, file)) await cache.put(item.key, item.value, item.expiresAt === undefined ? undefined : { expiresAt: item.expiresAt });
      }
      return file;
    }
  }
  const prepared = await prepare({ format, sourceInfo, readRange, tags, signal: client.ctx.signal });
  prepared.content.modifiedAt = new Date().toISOString();
  const packed = packPlan(prepared, picture);
  let known = sharedAssets.get(client); if (!known) { known = new Set(); sharedAssets.set(client, known); }
  const asset = packed.asset;
  const marker = asset ? `saved:${asset.key}` : '';
  const missingAsset = asset && !known.has(asset.key) && await cache.get(marker) !== true;
  const planKey = `tag-plan:${prepared.content.contentId}`;
  const file = { fileRef: JSON.stringify({ version: 2, source, planKey }), info: prepared.content };
  const writes = [...(missingAsset ? [{ key: asset.key, value: asset.value }, { key: marker, value: true }] : []),
    { key: planKey, value: packed.plan as unknown as Json }, { key: inputKey, value: planKey },
    ...(ready ? readyWrites(ready, file) : [])];
  if (cache.putMany) await cache.putMany(writes);
  else for (const item of writes) await cache.put(item.key, item.value, 'expiresAt' in item ? { expiresAt: item.expiresAt } : undefined);
  if (asset) known.add(asset.key);
  return file;
}

export type PreparedFile = { fileRef: string; info: FileInfo };
export const songKey = (source: MediaReference, sourceInfo: FileInfo, song: Record<string, unknown>) => hash([source, sourceInfo, song]).then(value => `ready:${value}`);
export const descriptorKey = (key: string) => key.replace(/^ready:/, 'tag-seed:');
export const reservationKey = (key: string) => key.replace(/^ready:/, 'reservation:');
export type ReservedGeneration = { id: string; modifiedAt: string };
function readyWrites(ready: { key: string; expiresAt: number | null }, file: PreparedFile): { key: string; value: Json; expiresAt?: number }[] {
  return [{ key: ready.key, value: file as unknown as Json, ...(ready.expiresAt === null ? {} : { expiresAt: ready.expiresAt }) },
    // A prepared file now owns its dependency expiry. Never reuse an older unprepared reservation after that expiry.
    { key: reservationKey(ready.key), value: null, expiresAt: Date.now() }];
}
export const deferredFileRef = (source: MediaReference, key: string) => JSON.stringify({ version: 3, source, descriptorKey: descriptorKey(key) });
const reserveBytes = 1_048_576;
const reservedInfo = (ref: ReservedReference): FileInfo => ({ ...info(ref.source), size: info(ref.source).size + reserveBytes,
  contentId: `netease-reserved-v1:${ref.generation}:${ref.descriptorKey.slice('tag-seed:'.length)}`, modifiedAt: ref.modifiedAt });
/** A scan generation is shared by its pages. Prepared ready entries retain their previous generation. */
export function reservedFile(source: MediaReference, key: string, generation: ReservedGeneration): PreparedFile {
  const ref: ReservedReference = { version: 4, source, descriptorKey: descriptorKey(key), generation: generation.id, modifiedAt: generation.modifiedAt };
  return { fileRef: JSON.stringify(ref), info: reservedInfo(ref) };
}
/** Small index is written after the permanent plan; hits never load/parse embedded artwork. */
export async function prepareSongFile(client: NeteaseClient, key: string, source: MediaReference, sourceInfo: FileInfo, song: Record<string, unknown>, readRange: ReadRange,
  metadataConcurrency: 1 | 2 = 1): Promise<PreparedFile> {
  const material = await musicTags(client, song, metadataConcurrency);
  return tagFile(client, source, sourceInfo, source.type as AudioFormat, material.tags, readRange, { key, expiresAt: material.expiresAt });
}

async function ensurePrepared(client: NeteaseClient, ref: Extract<Reference, { version: 3 }>, readRange: ReadRange): Promise<PreparedFile> {
  client.requireSession();
  const cache = client.ctx.cache;
  if (!cache) fail('not_supported', '网易云补标签需要支持插件资料缓存的宿主。');
  const key = ref.descriptorKey.replace(/^tag-seed:/, 'ready:');
  const ready = await cache.get(key);
  if (ready) return ready as unknown as PreparedFile;
  const song = await cache.get(ref.descriptorKey);
  if (!song) fail('temporary', '网易云补标签歌曲资料已丢失，请重新刷新目录。');
  return prepareSongFile(client, key, ref.source, info(ref.source), song as Record<string, unknown>, readRange, client.ctx.workBudget ? 1 : 2);
}

type ReservedPlan = { plan: StoredPlan; expiresAt: number | null };
async function reservedPlan(client: NeteaseClient, ref: ReservedReference, readRange: ReadRange): Promise<StoredPlan> {
  client.requireSession();
  const cache = client.ctx.cache;
  if (!cache?.putIfAbsent) fail('not_supported', '按需文件需要支持首次写入固定计划的宿主。');
  const content = reservedInfo(ref), key = `reserved-plan:${content.contentId}`;
  const cached = await cache.get(key) as unknown as ReservedPlan | undefined;
  if (cached) return cached.plan;
  const readyKey = ref.descriptorKey.replace(/^tag-seed:/, 'ready:');
  const ready = await cache.get(readyKey) as unknown as PreparedFile | undefined;
  if (ready && JSON.parse(ready.fileRef).version === 2) fail('content_changed', '此歌曲已单独准备，请刷新目录后重新打开。');
  const song = await cache.get(ref.descriptorKey);
  if (!song) fail('temporary', '网易云歌曲资料已丢失，请重新刷新目录。');
  const material = await musicTags(client, song as Record<string, unknown>, client.ctx.workBudget ? 1 : 2);
  let prepared: TaggedPlan;
  try {
    prepared = await prepare({ format: ref.source.type as AudioFormat, sourceInfo: info(ref.source), readRange,
      tags: material.tags, reserveBytes, signal: client.ctx.signal });
  } catch (error) {
    if (!(error instanceof AudioReservationError)) throw error;
    // The old advertised file must not grow. Publish an exact single-file result on the next refresh.
    await tagFile(client, ref.source, info(ref.source), ref.source.type as AudioFormat, material.tags, readRange,
      { key: readyKey, expiresAt: material.expiresAt });
    fail('content_changed', '此歌曲资料超过1MiB预留空间，已单独准备；请刷新目录后重新打开。');
  }
  prepared.content = content;
  const picture = material.tags.cover ? { data: material.tags.cover.data, digest: await byteHash(material.tags.cover.data) } : undefined;
  const packed = packPlan(prepared, picture);
  if (packed.asset) await cache.put(packed.asset.key, packed.asset.value);
  const winner = await cache.putIfAbsent(key, { plan: packed.plan, expiresAt: material.expiresAt } as unknown as Json) as unknown as ReservedPlan;
  // The permanent first winner owns bytes; a TTL only controls reuse by future catalogue scans.
  const writes = readyWrites({ key: readyKey, expiresAt: winner.expiresAt }, { fileRef: JSON.stringify(ref), info: content });
  if (cache.putMany) await cache.putMany(writes);
  else for (const item of writes) await cache.put(item.key, item.value, item.expiresAt === undefined ? undefined : { expiresAt: item.expiresAt });
  return winner.plan;
}

export async function taggedStat(client: NeteaseClient, ref: Reference, readRange: ReadRange) {
  client.requireSession();
  return ref.version === 4 ? reservedInfo(ref) : ref.version === 3 ? (await ensurePrepared(client, ref, readRange)).info : (await plan(client, ref.planKey)).content;
}
export async function taggedOpen(client: NeteaseClient, ref: Reference, input: ReadRequest, readRange: ReadRange): Promise<ReadResult> {
  // A HEAD-selected permanent plan stays readable after refreshed metadata replaces the ready index.
  if (ref.version === 4 && input.expectedContentId !== reservedInfo(ref).contentId) fail('content_changed', '网易云文件表示已变化，请重新打开。');
  const saved = ref.version === 4 ? await reservedPlan(client, ref, readRange)
    : await plan(client, ref.version === 3 ? `tag-plan:${input.expectedContentId}` : ref.planKey);
  if (saved.content.contentId !== input.expectedContentId || saved.source.contentId !== info(ref.source).contentId) fail('content_changed', '网易云补标签文件版本已变化，请刷新目录。');
  return open(await unpackPlan(client.ctx.cache!, saved), readRange, input.range, client.ctx.signal);
}
