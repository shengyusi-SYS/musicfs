import { expect, test } from 'bun:test';
import { parseBuffer } from 'music-metadata';
import { AudioReservationError, open, prepare, type AudioTags, type TaggedPlan } from './src';
import { segmentSize } from './src/bytes';
import { cover, fixture, originalLyrics, parseFlac, romanization, translation } from './test-fixtures';

const reserveBytes = 1024 * 1024;
const signal = () => new AbortController().signal;
const tags: AudioTags = { title: '按需歌曲', artists: ['歌手甲', '歌手乙'], album: '按需专辑',
  cover: { mimeType: 'image/png', data: cover }, lyrics: { original: originalLyrics, translation, romanization } };
const bodyBytes = async (body: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(body).arrayBuffer());

for (const format of ['mp3', 'flac', 'm4a'] as const) {
  test(`${format}: reserved plan is compact, legal and preserves audio with exact whole-file and Range reads`, async () => {
    const input = fixture(format);
    const plan = await prepare({ format, sourceInfo: input.info, readRange: input.readRange, tags, reserveBytes, signal: signal() });
    expect(plan.content.size).toBe(input.info.size + reserveBytes);
    expect(JSON.stringify(plan).length).toBeLessThan(16 * 1024);
    const cached: TaggedPlan = JSON.parse(JSON.stringify(plan));
    const output = await bodyBytes((await open(cached, input.readRange, undefined, signal())).body);
    expect(output.length).toBe(plan.content.size);
    const parsed = await parseBuffer(output, { mimeType: plan.content.mediaType, size: output.length });
    expect(parsed.common.title).toBe(tags.title);
    expect(parsed.common.artists).toEqual(tags.artists);
    expect(parsed.common.album).toBe(tags.album);
    expect(parsed.common.picture?.[0]?.data).toEqual(cover);
    if (format === 'mp3') {
      expect(output[3]).toBe(3);
      const audioOffset = 10 + output.subarray(6, 10).reduce((size, byte) => size * 128 + byte, 0);
      expect(output.slice(audioOffset)).toEqual(input.audio);
    } else if (format === 'flac') {
      const flac = parseFlac(output);
      expect(flac.blocks.some(block => block.type === 1)).toBe(true);
      expect(flac.audio).toEqual(input.audio);
    } else {
      expect(output.slice(input.audioStart, input.audioStart + input.audio.length)).toEqual(input.audio);
      // Parse every top-level box to prove the trailing free box has an exact, legal length.
      let offset = 0; let lastType = '';
      while (offset < output.length) {
        const size = new DataView(output.buffer, output.byteOffset + offset).getUint32(0);
        lastType = new TextDecoder().decode(output.subarray(offset + 4, offset + 8));
        expect(size).toBeGreaterThanOrEqual(8); offset += size;
      }
      expect(offset).toBe(output.length); expect(lastType).toBe('free');
    }
    const serialized = new TextDecoder().decode(output);
    for (const text of Object.values(tags.lyrics!)) {
      if (format !== 'mp3') expect(serialized).toContain(format === 'flac' ? text!.trim() : text!);
    }
    let position = 0;
    const zero = cached.segments.flatMap(part => {
      const start = position; position += segmentSize(part);
      return part.kind === 'zeros' ? [{ start, end: position - 1 }] : [];
    })[0]!;
    expect(zero.end - zero.start).toBeGreaterThan(64 * 1024);
    for (const range of [
      { start: zero.start + 100, end: zero.start + 199 },
      { start: zero.start - 2, end: zero.start + 2 },
      { start: zero.end - 2, end: Math.min(output.length - 1, zero.end + 32) },
      { start: output.length - 64, end: output.length - 1 },
    ]) {
      input.requests.length = 0;
      const read = await open(cached, input.readRange, range, signal());
      expect(read.servedRange).toEqual(range);
      expect(await bodyBytes(read.body)).toEqual(output.slice(range.start, range.end + 1));
      const sourceBytes = input.requests.reduce((sum, part) => sum + part.end - part.start + 1, 0);
      expect(sourceBytes).toBeLessThanOrEqual(range.end - range.start + 1);
      if (range.start >= zero.start && range.end <= zero.end) expect(input.requests).toHaveLength(0);
    }
    const again = await prepare({ format, sourceInfo: input.info, readRange: input.readRange, tags, reserveBytes, signal: signal() });
    expect(again.content).toEqual(plan.content);
  });
}

test('zero-fill output stays bounded and cancelling while in padding cancels the original audio read', async () => {
  const input = fixture('mp3');
  const plan = await prepare({ format: 'mp3', sourceInfo: input.info, readRange: input.readRange, tags, reserveBytes, signal: signal() });
  let cancelled = false; let sourceSignal: AbortSignal | undefined;
  const result = await open(plan, async (range, requestSignal) => {
    sourceSignal = requestSignal;
    return { content: input.info, servedRange: range,
      body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }, { highWaterMark: 0 }) };
  }, undefined, signal());
  const reader = result.body.getReader();
  await reader.read(); // Generated ID3 header/frames.
  const padding = await reader.read();
  expect(padding.value?.length).toBe(64 * 1024);
  expect(padding.value?.every(byte => byte === 0)).toBe(true);
  await reader.cancel('player stopped');
  expect(sourceSignal?.aborted).toBe(true); expect(cancelled).toBe(true);
});

test('insufficient reservation fails explicitly without truncating metadata; APE stays opt-out', async () => {
  const input = fixture('mp3');
  const overflow = prepare({ format: 'mp3', sourceInfo: input.info, readRange: input.readRange,
    tags: { lyrics: { original: '超'.repeat(4096) } }, reserveBytes: 256, signal: signal() });
  await expect(overflow).rejects.toBeInstanceOf(AudioReservationError);
  await expect(overflow).rejects.toMatchObject({ kind: 'not_supported', message: 'Audio metadata exceeds the reserved extra-byte budget.' });
  for (const format of ['flac', 'm4a'] as const) {
    const source = fixture(format);
    const variable = await prepare({ format, sourceInfo: source.info, readRange: source.readRange, tags, signal: signal() });
    await expect(prepare({ format, sourceInfo: source.info, readRange: source.readRange, tags,
      reserveBytes: variable.content.size - source.info.size + (format === 'flac' ? 3 : 7), signal: signal() }))
      .rejects.toBeInstanceOf(AudioReservationError);
  }
  const ape = fixture('ape');
  const unsupported = prepare({ format: 'ape', sourceInfo: ape.info, readRange: ape.readRange, tags, reserveBytes, signal: signal() });
  await expect(unsupported).rejects.toMatchObject({ kind: 'not_supported' });
  await expect(unsupported).rejects.not.toBeInstanceOf(AudioReservationError);
  expect(ape.requests).toHaveLength(0);
  await expect(prepare({ format: 'mp3', sourceInfo: input.info, readRange: input.readRange, tags, reserveBytes: -1, signal: signal() }))
    .rejects.toBeInstanceOf(RangeError);
});
