import { expect, test } from 'bun:test';
import { prepare, open } from '../packages/audio-tags/src';
import { fixture, cover } from '../packages/audio-tags/test-fixtures';
import { packPlan, unpackPlan } from '../plugins/netease/plan-storage';
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
