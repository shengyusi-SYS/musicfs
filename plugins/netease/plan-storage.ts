import { Buffer } from 'node:buffer';
import type { PluginCache } from '@musicfs/plugin-api';
import type { TaggedPlan, TagSegment } from '@musicfs/audio-tags';
import { fail } from './client';

type SharedBytes = { kind: 'shared'; key: string; before: string; after: string };
export type StoredPlan = Omit<TaggedPlan, 'segments'> & { segments: (TagSegment | SharedBytes)[] };

/** Storage codec only: reconstructed plans and exported audio stay byte-for-byte identical. */
export function packPlan(plan: TaggedPlan, picture?: { data: Uint8Array; digest: string }) {
  let shared = false;
  const key = picture ? `tag-bytes:${picture.digest}` : '';
  const segments = plan.segments.map(segment => {
    if (segment.kind !== 'bytes' || !picture || picture.data.length < 8192) return segment;
    const bytes = Buffer.from(segment.base64, 'base64');
    const offset = bytes.indexOf(picture.data);
    if (offset < 0) return segment;
    shared = true;
    return { kind: 'shared' as const, key, before: bytes.subarray(0, offset).toString('base64'),
      after: bytes.subarray(offset + picture.data.length).toString('base64') };
  });
  return { plan: { ...plan, segments } as StoredPlan,
    ...(shared ? { asset: { key, value: Buffer.from(picture!.data).toString('base64') } } : {}) };
}

export async function unpackPlan(cache: PluginCache, plan: StoredPlan): Promise<TaggedPlan> {
  const keys = [...new Set(plan.segments.flatMap(segment => segment.kind === 'shared' ? [segment.key] : []))];
  if (!keys.length) return plan as TaggedPlan;
  const values = cache.getMany ? await cache.getMany(keys) : await Promise.all(keys.map(key => cache.get(key)));
  const blobs = new Map(keys.map((key, i) => [key, values[i]]));
  return { ...plan, segments: plan.segments.flatMap((segment): TagSegment[] => {
    if (segment.kind !== 'shared') return [segment];
    const value = blobs.get(segment.key);
    if (typeof value !== 'string') fail('temporary', '网易云补标签图片资料已丢失，请重新刷新目录。');
    return [{ kind: 'bytes', base64: segment.before }, { kind: 'bytes', base64: value }, { kind: 'bytes', base64: segment.after }];
  }) };
}
