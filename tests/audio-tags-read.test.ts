import { expect, test } from 'bun:test';
import type { ByteRange, ReadResult } from '@musicfs/plugin-api';
import { AudioTagError, open, prepare, type ReadRange } from '../packages/audio-tags/src';
import { bufferedRanges, readBytes } from '../packages/audio-tags/src/read';
import { fixture } from '../packages/audio-tags/test-fixtures';

const signal = () => new AbortController().signal;
const bodyBytes = async (result: ReadResult) => new Uint8Array(await new Response(result.body).arrayBuffer());

for (const format of ['mp3', 'ape'] as const) {
  test(`${format}: one optional readMany prepares the same exact file, while open remains a single-range stream`, async () => {
    const baseline = fixture(format);
    const expected = await prepare({ format, sourceInfo: baseline.info, readRange: baseline.readRange, tags: { title: 'Updated title' }, signal: signal() });
    const input = fixture(format); const batches: ByteRange[][] = [];
    const readRange: ReadRange = input.readRange;
    readRange.readMany = async (ranges, requestSignal) => {
      batches.push(ranges.map(range => ({ ...range })));
      return Promise.all(ranges.map(range => input.readRange(range, requestSignal)));
    };
    const actual = await prepare({ format, sourceInfo: input.info, readRange, tags: { title: 'Updated title' }, signal: signal() });
    expect(actual).toEqual(expected);
    expect(baseline.requests).toHaveLength(2);
    expect(batches).toEqual([[{ start: 0, end: 4095 }, { start: input.info.size - 4096, end: input.info.size - 1 }]]);
    input.requests.length = 0;
    const finalRange = { start: actual.content.size - 128, end: actual.content.size - 1 };
    const output = await bodyBytes(await open(actual, readRange, finalRange, signal()));
    expect(output).toEqual(await bodyBytes(await open(expected, baseline.readRange, finalRange, signal())));
    expect(batches).toHaveLength(1);
    expect(input.requests.length).toBeLessThanOrEqual(1);
  });
}

test('small or overlapping preparation windows use one exact single range instead of a multipart request', async () => {
  for (const size of [128, 6000, 8192]) {
    const data = Uint8Array.from({ length: size }, (_, index) => index % 251);
    const sourceInfo = { contentId: `source-${size}`, size, mediaType: 'audio/mpeg' };
    const requests: ByteRange[] = []; let batches = 0;
    const readRange: ReadRange = async range => {
      requests.push(range); return { content: sourceInfo, servedRange: range, body: new Blob([data.slice(range.start, range.end + 1)]).stream() };
    };
    readRange.readMany = async () => { batches++; throw new Error('unneeded multipart request'); };
    const options = { format: 'mp3' as const, sourceInfo, readRange, tags: {}, signal: signal() };
    const buffered = { ...options, readRange: bufferedRanges(options) };
    expect(await readBytes(buffered, 0, 9)).toEqual(data.slice(0, 10));
    expect(await readBytes(buffered, size - 128, size - 1)).toEqual(data.slice(size - 128));
    expect(requests).toEqual([{ start: 0, end: size - 1 }]); expect(batches).toBe(0);
  }
});

test('FLAC and M4A do not invoke optional head/tail batching', async () => {
  for (const format of ['flac', 'm4a'] as const) {
    const input = fixture(format); let batches = 0;
    input.readRange.readMany = async () => { batches++; throw new Error('unneeded tail prefetch'); };
    const plan = await prepare({ format, sourceInfo: input.info, readRange: input.readRange, tags: {}, signal: signal() });
    expect(plan.content.size).toBeGreaterThan(0); expect(batches).toBe(0);
  }
});

test('readMany results retain exact identity, closed-range and body-length validation', async () => {
  for (const failure of ['identity', 'range', 'short', 'extra', 'missing'] as const) {
    const input = fixture('mp3'); let requests = 0;
    const readRange: ReadRange = async () => { requests++; throw new Error('must not retry as single ranges'); };
    readRange.readMany = async (ranges, requestSignal) => {
      const results = await Promise.all(ranges.map(range => input.readRange(range, requestSignal)));
      if (failure === 'missing') return results.slice(0, 1);
      const result = results[1]!;
      if (failure === 'identity') result.content = { ...result.content, contentId: 'different-version' };
      if (failure === 'range') result.servedRange = { start: ranges[1]!.start + 1, end: ranges[1]!.end };
      if (failure === 'short' || failure === 'extra') {
        await result.body.cancel();
        result.body = new Blob([new Uint8Array(failure === 'short' ? 4095 : 4097)]).stream();
      }
      return results;
    };
    await expect(prepare({ format: 'mp3', sourceInfo: input.info, readRange, tags: {}, signal: signal() })).rejects.toBeInstanceOf(AudioTagError);
    expect(requests).toBe(0);
  }
});
