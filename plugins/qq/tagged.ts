import type { FileInfo, Json, ReadRequest, ReadResult } from '@musicfs/plugin-api';
import { open, prepare, type AudioFormat, type AudioTags, type ReadRange, type TaggedPlan } from '@musicfs/audio-tags';
import { z } from 'zod';
import { fail, type QqClient } from './client';
import { decodeFile, type MediaReference } from './playback';

const reference = z.object({ version: z.literal(2), source: z.unknown(), planKey: z.string().min(1), readyKey: z.string().optional() }).strict();
type Reference = { source: MediaReference; planKey: string; readyKey?: string };
const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
const byteHash = async (value: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value))), byte => byte.toString(16).padStart(2, '0')).join('');

export function decodeTagged(file: string): Reference | undefined {
  let raw: unknown; try { raw = JSON.parse(file); } catch { return; }
  if ((raw as { version?: unknown } | null)?.version !== 2) return;
  const parsed = reference.safeParse(raw);
  if (!parsed.success) fail('not_found', 'QQ 补标签文件引用无效。');
  return { source: decodeFile(JSON.stringify(parsed.data.source)), planKey: parsed.data.planKey,
    ...(parsed.data.readyKey ? { readyKey: parsed.data.readyKey } : {}) };
}

async function plan(client: QqClient, ref: Reference): Promise<TaggedPlan> {
  client.requireSession();
  if (!client.ctx.cache) fail('not_supported', 'QQ 补标签需要支持插件资料缓存的宿主。');
  const saved = await client.ctx.cache.get(ref.planKey);
  if (saved === undefined || saved === null) {
    if (ref.readyKey) await client.ctx.cache.put(ref.readyKey, null, { expiresAt: Date.now() });
    fail('temporary', 'QQ 补标签文件资料已丢失，请重新刷新目录。');
  }
  return saved as unknown as TaggedPlan;
}

export type PreparedFile = { fileRef: string; info: FileInfo; metadataRefreshId?: string };
type InputIndex = { planKey: string; info: FileInfo };
export const songKey = (source: MediaReference, sourceInfo: FileInfo, song: Record<string, unknown>) =>
  hash([source, sourceInfo, song]).then(value => `ready:${value}`);

export async function tagFile(client: QqClient, source: MediaReference, sourceInfo: FileInfo, format: AudioFormat, tags: AudioTags, readRange: ReadRange,
  ready?: { key: string; expiresAt: number | null }): Promise<PreparedFile> {
  const cache = client.ctx.cache;
  if (!cache) fail('not_supported', 'QQ 补标签需要支持插件资料缓存的宿主。');
  const tagIdentity = tags.cover ? { ...tags, cover: { mimeType: tags.cover.mimeType, description: tags.cover.description, digest: await byteHash(tags.cover.data) } } : tags;
  const inputKey = `tag-input:${await hash([source, sourceInfo, tagIdentity])}`;
  const previous = await cache.get(inputKey);
  const index = typeof previous === 'string' ? { planKey: previous } : previous as unknown as InputIndex | undefined;
  const writes: { key: string; value: Json; expiresAt?: number }[] = [];
  let prepared: TaggedPlan | undefined;
  if (index?.planKey) {
    const saved = await cache.get(index.planKey);
    if (saved !== undefined && saved !== null) prepared = saved as unknown as TaggedPlan;
  }
  if (!prepared) {
    prepared = await prepare({ format, sourceInfo, readRange, tags, signal: client.ctx.signal });
    const oldInfo = index && 'info' in index ? index.info : undefined;
    prepared.content.modifiedAt = oldInfo?.contentId === prepared.content.contentId && oldInfo.modifiedAt ? oldInfo.modifiedAt : new Date().toISOString();
    writes.push({ key: `tag-plan:${prepared.content.contentId}`, value: prepared as unknown as Json });
  } else if (!prepared.content.modifiedAt) {
    prepared.content.modifiedAt = new Date().toISOString();
    writes.push({ key: index!.planKey, value: prepared as unknown as Json });
  }
  const planKey = `tag-plan:${prepared.content.contentId}`;
  const file = { fileRef: JSON.stringify({ version: 2, source, planKey, ...(ready ? { readyKey: ready.key } : {}) }), info: prepared.content };
  writes.push({ key: inputKey, value: { planKey, info: prepared.content } as unknown as Json });
  if (ready) writes.push({ key: ready.key, value: { ...file, ...(client.ctx.metadataRefresh ? { metadataRefreshId: client.ctx.metadataRefresh } : {}) } as unknown as Json,
    ...(ready.expiresAt === null ? {} : { expiresAt: ready.expiresAt }) });
  if (cache.putMany) await cache.putMany(writes);
  else for (const item of writes) await cache.put(item.key, item.value, item.expiresAt === undefined ? undefined : { expiresAt: item.expiresAt });
  return file;
}

export async function taggedStat(client: QqClient, ref: Reference) { return (await plan(client, ref)).content; }
export async function taggedOpen(client: QqClient, ref: Reference, input: ReadRequest, sourceRead: (info: FileInfo) => ReadRange): Promise<ReadResult> {
  const saved = await plan(client, ref);
  if (saved.content.contentId !== input.expectedContentId) fail('content_changed', 'QQ 补标签文件版本已变化，请刷新目录。');
  return open(saved, sourceRead(saved.source), input.range, client.ctx.signal);
}
