import { Buffer } from 'node:buffer';
import type { ByteRange, PluginCache } from '@musicfs/plugin-api';
import { open, type ReadRange, type TaggedPlan, type TagSegment } from '@musicfs/audio-tags';
import { fail } from './client';

type SharedBytes = { kind: 'shared'; key: string; before: string; after: string; pictureBytes?: number };
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
    return { kind: 'shared' as const, key, pictureBytes: picture.data.length, before: bytes.subarray(0, offset).toString('base64'),
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

/** Keep the range-specific placeholder plan inside this codec; it must never be exported or persisted. */
export async function openStoredPlan(cache: PluginCache, plan: StoredPlan, readRange: ReadRange, range: ByteRange | undefined,
  signal: AbortSignal) {
  signal.throwIfAborted();
  let selected = plan;
  // Old shared segments have no byte length. Restore them normally rather than guessing offsets.
  if (range && plan.segments.every(segment => segment.kind !== 'shared'
    || Number.isSafeInteger(segment.pictureBytes) && segment.pictureBytes! >= 0)) {
    let offset = 0;
    selected = { ...plan, segments: plan.segments.flatMap((segment): StoredPlan['segments'] => {
      if (segment.kind !== 'shared') {
        offset += segment.kind === 'bytes' ? Buffer.byteLength(segment.base64, 'base64')
          : segment.kind === 'zeros' ? segment.size : segment.end - segment.start + 1;
        return [segment];
      }
      const start = offset + Buffer.byteLength(segment.before, 'base64');
      const end = start + segment.pictureBytes!;
      offset = end + Buffer.byteLength(segment.after, 'base64');
      if (range.start < end && range.end >= start) return [segment];
      return [{ kind: 'bytes', base64: segment.before }, { kind: 'zeros', size: segment.pictureBytes! },
        { kind: 'bytes', base64: segment.after }];
    }) };
  }
  return open(await unpackPlan(cache, selected), readRange, range, signal);
}
