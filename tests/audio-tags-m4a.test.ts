import { expect, test } from 'bun:test';
import { parseBuffer } from 'music-metadata';
import { open, prepare } from '../packages/audio-tags/src';
import type { AudioTags, ReadRange } from '../packages/audio-tags/src';
import { fixture, cover, originalLyrics, translation, romanization } from '../packages/audio-tags/test-fixtures';
import { decode } from '../packages/audio-tags/src/bytes';
const signal = () => new AbortController().signal;
const tags = { title: '新歌名', artists: ['歌手甲', '歌手乙'], album: '专辑', albumArtists: ['专辑歌手甲', '专辑歌手乙'], date: '2026-10-21',
  track: { number: 3, total: 12 }, disc: { number: 2, total: 2 }, cover: { mimeType: 'image/png', data: cover },
  lyrics: { original: originalLyrics, translation, romanization } } satisfies AudioTags;
const fullBytes = async (body: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(body).arrayBuffer());
test('M4A updates only metadata, keeps mdat at the same position, and serves exact final-file ranges', async () => {
  const input = fixture('m4a');
  const plan = await prepare({ format: 'm4a', sourceInfo: input.info, readRange: input.readRange, tags, signal: signal() });
  const payloadReads = input.requests.filter(range => range.start < input.audioStart + input.audio.length && range.end >= input.audioStart);
  expect(payloadReads).toHaveLength(0);
  const output = await fullBytes((await open(plan, input.readRange, undefined, signal())).body);
  expect(output.slice(input.audioStart, input.audioStart + input.audio.length)).toEqual(input.audio);
  const parsed = await parseBuffer(output, { mimeType: 'audio/mp4', size: output.length });
  expect(parsed.common.title).toBe(tags.title); expect(parsed.common.artists).toEqual(tags.artists);
  expect(parsed.common.album).toBe(tags.album); expect(parsed.common.albumartists).toEqual(tags.albumArtists);
  expect(parsed.common.date).toBe(tags.date); expect(parsed.common.track).toEqual({ no: 3, of: 12 });
  expect(parsed.common.disk).toEqual({ no: 2, of: 2 }); expect(parsed.common.picture?.[0]?.data).toEqual(cover);
  expect(parsed.common.lyrics?.[0]?.syncText).toEqual([{ timestamp: 0, text: '原文' }, { timestamp: 500, text: '第二行' }]);
  const allTags = new TextDecoder().decode(decode((plan.segments.at(-1) as { base64: string }).base64));
  expect(allTags).toContain(translation); expect(allTags).toContain(romanization);
  for (const range of [{ start: 0, end: 63 }, { start: input.audioStart + 10, end: input.audioStart + 32 },
    { start: input.bytes.length - 2, end: input.bytes.length + 3 }, { start: output.length - 17, end: output.length - 1 }]) {
    input.requests.length = 0;
    const result = await open(plan, input.readRange, range, signal());
    expect(await fullBytes(result.body)).toEqual(output.slice(range.start, range.end + 1));
    expect(input.requests.reduce((total, part) => total + part.end - part.start + 1, 0)).toBeLessThanOrEqual(range.end - range.start + 1);
  }
  const changed = await prepare({ format: 'm4a', sourceInfo: input.info, readRange: input.readRange, tags, signal: signal() });
  expect(changed.content).toEqual(plan.content);
});
test('M4A missing fields preserve existing tags without loading source audio', async () => {
  const input = fixture('m4a');
  const initial = await prepare({ format: 'm4a', sourceInfo: input.info, readRange: input.readRange, tags, signal: signal() });
  const sourceBytes = await fullBytes((await open(initial, input.readRange, undefined, signal())).body);
  const requests: { start: number; end: number }[] = [];
  const readRange: ReadRange = async (range, requestSignal) => {
    requestSignal.throwIfAborted(); requests.push(range);
    return { content: initial.content, servedRange: range, body: new Blob([sourceBytes.slice(range.start, range.end + 1)]).stream() };
  };
  const plan = await prepare({ format: 'm4a', sourceInfo: initial.content, readRange, tags: { title: 'Only title changes' }, signal: signal() });
  expect(requests.every(range => range.end < input.audioStart || range.start >= input.audioStart + input.audio.length)).toBe(true);
  const output = await fullBytes((await open(plan, readRange, undefined, signal())).body);
  const parsed = await parseBuffer(output, { mimeType: 'audio/mp4', size: output.length });
  expect(parsed.common.title).toBe('Only title changes'); expect(parsed.common.album).toBe(tags.album);
  expect(parsed.common.artists).toEqual(tags.artists); expect(parsed.common.picture?.[0]?.data).toEqual(cover);
  expect(parsed.common.date).toBe(tags.date);
});
test('M4A can create ordinary tags when the source movie has no user-data box', async () => {
  const input = fixture('m4a');
  const original = Buffer.from(input.bytes);
  const userDataStart = original.indexOf(Buffer.from('udta')) - 4;
  const movieStart = original.indexOf(Buffer.from('moov')) - 4;
  const userDataSize = original.readUInt32BE(userDataStart);
  const source = Buffer.concat([original.subarray(0, userDataStart), original.subarray(userDataStart + userDataSize)]);
  source.writeUInt32BE(original.readUInt32BE(movieStart) - userDataSize, movieStart);
  const info = { ...input.info, contentId: 'm4a-without-user-data', size: source.length };
  const readRange: ReadRange = async (range, requestSignal) => {
    requestSignal.throwIfAborted();
    return { content: info, servedRange: range, body: new Blob([source.subarray(range.start, range.end + 1)]).stream() };
  };
  const plan = await prepare({ format: 'm4a', sourceInfo: info, readRange, tags, signal: signal() });
  const output = await fullBytes((await open(plan, readRange, undefined, signal())).body);
  const parsed = await parseBuffer(output, { mimeType: 'audio/mp4', size: output.length });
  expect(parsed.common.title).toBe(tags.title); expect(parsed.common.artists).toEqual(tags.artists);
  expect(parsed.common.picture?.[0]?.data).toEqual(cover);
  expect(output.slice(input.audioStart, input.audioStart + input.audio.length)).toEqual(input.audio);
});
