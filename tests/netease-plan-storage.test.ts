import { expect, test } from 'bun:test';
import { prepare, open } from '../packages/audio-tags/src';
import { fixture, cover } from '../packages/audio-tags/test-fixtures';
import { openStoredPlan, packPlan, unpackPlan } from '../plugins/netease/plan-storage';
import { memoryCache } from './helpers/source-metadata';

for (const format of ['mp3', 'flac', 'm4a'] as const) {
  test(`${format}: large artwork is shared while restored plan, size, identity and bytes stay identical`, async () => {
    const source = fixture(format); const data = new Uint8Array(32_768); data.set(cover);
    const original = await prepare({ format, sourceInfo: source.info, readRange: source.readRange, signal: new AbortController().signal,
      tags: { title: 'Song', cover: { mimeType: 'image/png', data } } });
    const packed = packPlan(original, { data, digest: 'same-picture' });
    expect(packed.asset?.key).toBe('tag-bytes:same-picture');
    expect(JSON.stringify(packed.plan).length).toBeLessThan(JSON.stringify(original).length / 2);
    const cache = memoryCache(); await cache.put(packed.asset!.key, packed.asset!.value);
    const restored = await unpackPlan(cache, packed.plan);
    expect(restored.content).toEqual(original.content);
    const bytes = async (body: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(body).arrayBuffer());
    expect(await bytes((await open(restored, source.readRange, undefined, new AbortController().signal)).body))
      .toEqual(await bytes((await open(original, source.readRange, undefined, new AbortController().signal)).body));
    expect(await unpackPlan(cache, original)).toEqual(original);
  });
}

test('source-only ranges skip shared artwork while full reads and legacy plans preserve it', async () => {
  const source = fixture('mp3'); const data = new Uint8Array(32_768); data.set(cover);
  const signal = new AbortController().signal;
  const original = await prepare({ format: 'mp3', sourceInfo: source.info, readRange: source.readRange, signal,
    reserveBytes: 1_048_576, tags: { title: 'Song', cover: { mimeType: 'image/png', data } } });
  const packed = packPlan(original, { data, digest: 'range-picture' });
  const stored = memoryCache(); await stored.put(packed.asset!.key, packed.asset!.value);
  const reads: string[][] = []; let loadedBytes = 0;
  const load = async (keys: string[]) => {
    reads.push(keys);
    const values = await stored.getMany!(keys);
    loadedBytes += values.reduce<number>((total, value) => total + (typeof value === 'string' ? Buffer.byteLength(value) : 0), 0);
    return values;
  };
  const cache = { ...stored, get: async (key: string) => (await load([key]))[0], getMany: load };
  const bytes = async (body: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(body).arrayBuffer());
  const expected = await bytes((await open(original, source.readRange, undefined, signal)).body);
  const range = { start: original.content.size - 1024, end: original.content.size - 961 };
  const result = await openStoredPlan(cache, packed.plan, source.readRange, range, signal);
  expect(result.content).toEqual(original.content);
  expect(result.servedRange).toEqual(range);
  expect(await bytes(result.body)).toEqual(expected.slice(range.start, range.end + 1));
  expect(reads).toEqual([]);
  expect(loadedBytes).toBe(0);

  const pictureStart = Buffer.from(expected).indexOf(data);
  expect(pictureStart).toBeGreaterThan(0);
  const artworkRange = { start: pictureStart, end: pictureStart + 31 };
  const artwork = await openStoredPlan(cache, packed.plan, source.readRange, artworkRange, signal);
  expect(await bytes(artwork.body)).toEqual(expected.slice(artworkRange.start, artworkRange.end + 1));
  expect(reads).toEqual([[packed.asset!.key]]);
  reads.length = 0; loadedBytes = 0;

  const legacy = { ...packed.plan, segments: packed.plan.segments.map(segment => {
    if (segment.kind !== 'shared') return segment;
    const { pictureBytes: _, ...saved } = segment; return saved;
  }) };
  const oldResult = await openStoredPlan(cache, legacy, source.readRange, range, signal);
  expect(oldResult.content).toEqual(original.content);
  expect(await bytes(oldResult.body)).toEqual(expected.slice(range.start, range.end + 1));
  expect(reads).toEqual([[packed.asset!.key]]);
  expect(loadedBytes).toBe(43_692);
  expect((await unpackPlan(cache, legacy)).content).toEqual(original.content);

  reads.length = 0;
  const full = await openStoredPlan(cache, packed.plan, source.readRange, undefined, signal);
  expect(full.content).toEqual(original.content);
  expect(full.servedRange).toBeNull();
  expect(await bytes(full.body)).toEqual(expected);
  expect(reads).toEqual([[packed.asset!.key]]);
  await expect(openStoredPlan(memoryCache(), packed.plan, source.readRange, undefined, signal))
    .rejects.toThrow('网易云补标签图片资料已丢失');

  reads.length = 0;
  const cancelled = new AbortController(); cancelled.abort();
  await expect(openStoredPlan(cache, packed.plan, source.readRange, range, cancelled.signal)).rejects.toThrow();
  expect(reads).toEqual([]);
});
