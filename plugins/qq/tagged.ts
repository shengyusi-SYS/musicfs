import type { FileInfo, Json, ReadRequest, ReadResult } from '@musicfs/plugin-api';
import { open, prepare, type AudioFormat, type AudioTags, type ReadRange, type TaggedPlan } from '@musicfs/audio-tags';
import { z } from 'zod';
import { fail, type QqClient } from './client';
import { decodeFile, type MediaReference } from './playback';

const reference = z.object({ version: z.literal(2), source: z.unknown(), planKey: z.string().min(1) }).strict();
type Reference = { source: MediaReference; planKey: string };
const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
const byteHash = async (value: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value))), byte => byte.toString(16).padStart(2, '0')).join('');

export function decodeTagged(file: string): Reference | undefined {
  let raw: unknown; try { raw = JSON.parse(file); } catch { return; }
  if ((raw as { version?: unknown } | null)?.version !== 2) return;
  const parsed = reference.safeParse(raw);
  if (!parsed.success) fail('not_found', 'QQ 补标签文件引用无效。');
  return { source: decodeFile(JSON.stringify(parsed.data.source)), planKey: parsed.data.planKey };
}

async function plan(client: QqClient, ref: Reference): Promise<TaggedPlan> {
  client.requireSession();
  if (!client.ctx.cache) fail('not_supported', 'QQ 补标签需要支持插件资料缓存的宿主。');
  const saved = await client.ctx.cache.get(ref.planKey);
  if (saved === undefined || saved === null) fail('temporary', 'QQ 补标签文件资料已丢失，请重新刷新目录。');
  return saved as unknown as TaggedPlan;
}

export async function tagFile(client: QqClient, source: MediaReference, sourceInfo: FileInfo, format: AudioFormat, tags: AudioTags, readRange: ReadRange) {
  const cache = client.ctx.cache;
  if (!cache) fail('not_supported', 'QQ 补标签需要支持插件资料缓存的宿主。');
  const tagIdentity = tags.cover ? { ...tags, cover: { mimeType: tags.cover.mimeType, description: tags.cover.description, digest: await byteHash(tags.cover.data) } } : tags;
  const inputKey = `tag-input:${await hash([source, sourceInfo, tagIdentity])}`;
  const previous = await cache.get(inputKey);
  if (typeof previous === 'string') {
    const saved = await cache.get(previous);
    if (saved !== undefined && saved !== null) return { fileRef: JSON.stringify({ version: 2, source, planKey: previous }), info: (saved as unknown as TaggedPlan).content };
  }
  const prepared = await prepare({ format, sourceInfo, readRange, tags, signal: client.ctx.signal });
  const planKey = `tag-plan:${prepared.content.contentId}`;
  await cache.put(planKey, prepared as unknown as Json);
  await cache.put(inputKey, planKey);
  return { fileRef: JSON.stringify({ version: 2, source, planKey }), info: prepared.content };
}

export async function taggedStat(client: QqClient, ref: Reference) { return (await plan(client, ref)).content; }
export async function taggedOpen(client: QqClient, ref: Reference, input: ReadRequest, sourceRead: (info: FileInfo) => ReadRange): Promise<ReadResult> {
  const saved = await plan(client, ref);
  if (saved.content.contentId !== input.expectedContentId) fail('content_changed', 'QQ 补标签文件版本已变化，请刷新目录。');
  return open(saved, sourceRead(saved.source), input.range, client.ctx.signal);
}
