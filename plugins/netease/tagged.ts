import type { FileInfo, Json, ReadRequest, ReadResult } from '@musicfs/plugin-api';
import { open, prepare, type AudioFormat, type AudioTags, type ReadRange, type TaggedPlan } from '@musicfs/audio-tags';
import { z } from 'zod';
import { fail, type NeteaseClient } from './client';
import { decodeFile, type MediaReference } from './reference';
import { musicTags } from './metadata';
import { packPlan, unpackPlan, type StoredPlan } from './plan-storage';

const reference = z.object({ version: z.literal(2), source: z.unknown(), planKey: z.string().min(1) }).strict();
type Reference = { source: MediaReference; planKey: string };
const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
const byteHash = async (value: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value))), byte => byte.toString(16).padStart(2, '0')).join('');

export function decodeTagged(file: string): Reference | undefined {
  let raw: unknown; try { raw = JSON.parse(file); } catch { return; }
  if ((raw as { version?: unknown } | null)?.version !== 2) return;
  const parsed = reference.safeParse(raw);
  if (!parsed.success) fail('not_found', '网易云补标签文件引用无效。');
  return { source: decodeFile(JSON.stringify(parsed.data.source)), planKey: parsed.data.planKey };
}

async function plan(client: NeteaseClient, ref: Reference): Promise<StoredPlan> {
  client.requireSession();
  if (!client.ctx.cache) fail('not_supported', '网易云补标签需要支持插件资料缓存的宿主。');
  const saved = await client.ctx.cache.get(ref.planKey);
  if (saved === undefined || saved === null) fail('temporary', '网易云补标签文件资料已丢失，请重新刷新目录。');
  return saved as unknown as StoredPlan;
}

const sharedAssets = new WeakMap<NeteaseClient, Set<string>>();

export async function tagFile(client: NeteaseClient, source: MediaReference, sourceInfo: FileInfo, format: AudioFormat, tags: AudioTags, readRange: ReadRange,
  ready?: { key: string; expiresAt: number }) {
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
      if (ready) await cache.put(ready.key, file as unknown as Json, { expiresAt: ready.expiresAt });
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
    ...(ready ? [{ key: ready.key, value: file as unknown as Json, expiresAt: ready.expiresAt }] : [])];
  if (cache.putMany) await cache.putMany(writes);
  else for (const item of writes) await cache.put(item.key, item.value, 'expiresAt' in item ? { expiresAt: item.expiresAt } : undefined);
  if (asset) known.add(asset.key);
  return file;
}

export type PreparedFile = { fileRef: string; info: FileInfo };
export const songKey = (source: MediaReference, sourceInfo: FileInfo, song: Record<string, unknown>) => hash([source, sourceInfo, song]).then(value => `ready:${value}`);
/** Small index is written after the permanent plan; hits never load/parse embedded artwork. */
export async function prepareSongFile(client: NeteaseClient, key: string, source: MediaReference, sourceInfo: FileInfo, song: Record<string, unknown>, readRange: ReadRange): Promise<PreparedFile> {
  const material = await musicTags(client, song);
  return tagFile(client, source, sourceInfo, source.type as AudioFormat, material.tags, readRange, { key, expiresAt: material.expiresAt });
}

export async function taggedStat(client: NeteaseClient, ref: Reference) { return (await plan(client, ref)).content; }
export async function taggedOpen(client: NeteaseClient, ref: Reference, input: ReadRequest, readRange: ReadRange): Promise<ReadResult> {
  const saved = await plan(client, ref);
  if (saved.content.contentId !== input.expectedContentId) fail('content_changed', '网易云补标签文件版本已变化，请刷新目录。');
  return open(await unpackPlan(client.ctx.cache!, saved), readRange, input.range, client.ctx.signal);
}
