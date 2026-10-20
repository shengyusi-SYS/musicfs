import { expect, test } from 'bun:test';
import type { ReadResult } from '@musicfs/plugin-api';
import { AudioTagError, open, prepare, type AudioFormat, type AudioTags, type TaggedPlan } from '../packages/audio-tags/src';
import { decode, join, segmentSize } from '../packages/audio-tags/src/bytes';
import { fixture, cover, originalLyrics, translation, romanization, parseApe, parseFlac, parseId3, Id3v2FrameClassType, Id3v2FrameIdentifiers, Id3v2UnsynchronizedLyricsFrame } from '../packages/audio-tags/test-fixtures';
const signal = () => new AbortController().signal;
const tags = { title: '新歌名', artists: ['歌手甲', '歌手乙'], albumArtists: ['专辑歌手'], date: '2026-10-21',
  track: { number: 3, total: 12 }, disc: { number: 2, total: 2 }, lyrics: { original: originalLyrics, translation, romanization } } satisfies AudioTags;
const bytes = async (result: ReadResult) => new Uint8Array(await new Response(result.body).arrayBuffer());
function materialize(plan: TaggedPlan, input: Uint8Array) {
  return join(plan.segments.map(segment => segment.kind === 'bytes' ? decode(segment.base64) : input.slice(segment.start, segment.end + 1)));
}
for (const format of ['mp3', 'flac', 'ape'] as AudioFormat[]) {
  test(`${format}: prepare preserves untouched music bytes, missing fields and independent lyric variants`, async () => {
    const input = fixture(format);
    const plan = await prepare({ format, sourceInfo: input.info, readRange: input.readRange, tags, signal: signal() });
    const output = materialize(plan, input.bytes);
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
    expect(output.length).toBe(plan.content.size);
    expect(plan.content.contentId).not.toBe(input.info.contentId);
    expect(input.requests.every(range => range.end - range.start + 1 < input.audio.length)).toBe(true);
    if (format === 'mp3') {
      const prefix = decode((plan.segments[0] as { base64: string }).base64); const tag = parseId3(prefix);
      expect(tag.title).toBe(tags.title); expect(tag.performers).toEqual(tags.artists); expect(tag.album).toBe('Existing album');
      expect(tag.pictures[0]?.data.toByteArray()).toEqual(cover);
      const texts = tag.getFramesByClassType<Id3v2UnsynchronizedLyricsFrame>(Id3v2FrameClassType.UnsynchronizedLyricsFrame).map(frame => frame.text);
      expect(texts).toContain(originalLyrics); expect(texts).toContain(translation); expect(texts).toContain(romanization);
      expect(tag.getTextAsString(Id3v2FrameIdentifiers.TIT3!)).toBe('Existing subtitle');
      expect(tag.getTextAsString(Id3v2FrameIdentifiers.TYER!)).toBe('2026');
      expect(tag.getTextAsString(Id3v2FrameIdentifiers.TDAT!)).toBe('2110');
      expect(output.slice(prefix.length)).toEqual(input.audio);
    } else if (format === 'flac') {
      const parsed = parseFlac(output); const tag = parsed.comments[0]!;
      expect(tag.title).toBe(tags.title); expect(tag.performers).toEqual(tags.artists); expect(tag.album).toBe('Existing album');
      expect(tag.getField('CUSTOM')).toEqual(['preserve']);
      expect(tag.getField('DATE')).toEqual(['2026-10-21']); expect(tag.getField('LYRICS')).toEqual([originalLyrics.trim()]);
      expect(tag.getField('LYRICS_TRANSLATION')).toEqual([translation.trim()]); expect(tag.getField('LYRICS_ROMANIZATION')).toEqual([romanization.trim()]);
      expect(parsed.blocks.find(block => block.type === 0)?.payload).toEqual(new Uint8Array(34));
      expect(parsed.blocks.find(block => block.type === 2)?.payload).toEqual(new Uint8Array([4, 5, 6, 7]));
      expect(parsed.blocks.some(block => block.type === 6)).toBe(true); expect(parsed.audio).toEqual(input.audio);
    } else {
      const tail = decode((plan.segments.at(-1) as { base64: string }).base64); const tag = parseApe(tail);
      expect(tag.title).toBe(tags.title); expect(tag.performers).toEqual(tags.artists); expect(tag.album).toBe('Existing album');
      expect(tag.getItem('CUSTOM')?.text).toEqual(['preserve']); expect(tag.getItem('Year')?.text).toEqual(['2026-10-21']);
      expect(tag.getItem('Lyrics')?.text).toEqual([originalLyrics]); expect(tag.getItem('LyricsTranslation')?.text).toEqual([translation]);
      expect(tag.getItem('LyricsRomanization')?.text).toEqual([romanization]); expect(tag.pictures[0]?.data.toByteArray()).toEqual(cover);
      expect(output.slice(4, 4 + input.audio.length)).toEqual(input.audio);
    }
    const again = await prepare({ format, sourceInfo: input.info, readRange: input.readRange, tags, signal: signal() });
    expect(again.content).toEqual(plan.content);
    const changed = await prepare({ format, sourceInfo: input.info, readRange: input.readRange, tags: { ...tags, title: '另一首' }, signal: signal() });
    expect(changed.content.contentId).not.toBe(plan.content.contentId);
  });
  test(`${format}: exact full, prefix, boundary and tail ranges use only source intersections`, async () => {
    const input = fixture(format);
    const plan = await prepare({ format, sourceInfo: input.info, readRange: input.readRange, tags, signal: signal() });
    const output = materialize(plan, input.bytes);
    const firstBoundary = segmentSize(plan.segments[0]!);
    for (const range of [undefined, { start: 0, end: 31 }, { start: Math.max(0, firstBoundary - 2), end: firstBoundary + 2 },
      { start: output.length - 9, end: output.length - 1 }]) {
      input.requests.length = 0;
      const result = await open(JSON.parse(JSON.stringify(plan)) as TaggedPlan, input.readRange, range, signal());
      expect(result.servedRange).toEqual(range ?? null); expect(result.content).toEqual(plan.content);
      expect(await bytes(result)).toEqual(new Uint8Array(range ? output.slice(range.start, range.end + 1) : output));
      if (range) expect(input.requests.reduce((total, part) => total + part.end - part.start + 1, 0)).toBeLessThanOrEqual(range.end - range.start + 1);
    }
  });
}
test('cover replacement removes old FLAC picture and leaves metadata absent from the request intact', async () => {
  const input = fixture('flac'); const replacement = new Uint8Array([1, 2, 3, 4]);
  const plan = await prepare({ format: 'flac', sourceInfo: input.info, readRange: input.readRange,
    tags: { cover: { data: replacement, mimeType: 'image/jpeg' } }, signal: signal() });
  const parsed = parseFlac(materialize(plan, input.bytes)); expect(parsed.blocks.filter(block => block.type === 6)).toHaveLength(1);
  expect(parsed.comments[0]?.album).toBe('Existing album');
});
test('source version change is rejected before returning a tagged audio response', async () => {
  const input = fixture('mp3'); const plan = await prepare({ format: 'mp3', sourceInfo: input.info, readRange: input.readRange, tags, signal: signal() });
  const reader = async (range: { start: number; end: number }, requestSignal: AbortSignal) => {
    const value = await input.readRange(range, requestSignal); value.content = { ...value.content, contentId: 'changed' }; return value;
  };
  await expect(open(plan, reader, undefined, signal())).rejects.toBeInstanceOf(AudioTagError);
});
test('cancelling a tagged stream aborts the active source request without buffering remaining audio', async () => {
  const input = fixture('mp3'); const plan = await prepare({ format: 'mp3', sourceInfo: input.info, readRange: input.readRange, tags, signal: signal() });
  let cancelled = false; let sourceSignal: AbortSignal | undefined;
  const result = await open(plan, async (range, requestSignal) => {
    sourceSignal = requestSignal;
    return { content: input.info, servedRange: range, body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }, { highWaterMark: 0 }) };
  }, undefined, signal());
  const reader = result.body.getReader(); await reader.read(); await reader.cancel('player stopped');
  expect(sourceSignal?.aborted).toBe(true); expect(cancelled).toBe(true);
});
