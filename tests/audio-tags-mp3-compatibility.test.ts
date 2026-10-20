import { expect, test } from 'bun:test';
import { parseBuffer } from 'music-metadata';
import { prepare, open } from '../packages/audio-tags/src';
import { fixture, cover, originalLyrics, translation, romanization } from '../packages/audio-tags/test-fixtures';
test('MP3 emits v2.3 UTF-16 tags with full native date, multiple artists, cover and separate timed lyric texts', async () => {
  const input = fixture('mp3'); const signal = new AbortController().signal;
  const plan = await prepare({ format: 'mp3', sourceInfo: input.info, readRange: input.readRange, signal,
    tags: { title: '兼容中文标题', artists: ['歌手甲', '歌手乙'], date: '2026-10-21',
      cover: { mimeType: 'image/png', data: cover }, lyrics: { original: originalLyrics, translation, romanization } } });
  const output = new Uint8Array(await new Response((await open(plan, input.readRange, undefined, signal)).body).arrayBuffer());
  expect(output[3]).toBe(3);
  const titleOffset = Buffer.from(output).indexOf(Buffer.from('TIT2'));
  expect(output[titleOffset + 10]).toBe(1); // ID3 text encoding 1: UTF-16 with BOM.
  const parsed = await parseBuffer(output, { mimeType: 'audio/mpeg', size: output.length });
  expect(parsed.common.title).toBe('兼容中文标题'); expect(parsed.common.artists).toEqual(['歌手甲', '歌手乙']);
  expect(parsed.common.picture?.[0]?.data).toEqual(cover);
  const native = parsed.native['ID3v2.3']!;
  expect(native.find(tag => tag.id === 'TYER')?.value).toBe('2026');
  expect(native.find(tag => tag.id === 'TDAT')?.value).toBe('2110');
  const lyrics = native.filter(tag => tag.id === 'USLT').map(tag => tag.value as { language: string; descriptor: string; text: string });
  expect(lyrics).toContainEqual({ language: 'XXX', descriptor: '', text: originalLyrics });
  expect(lyrics).toContainEqual({ language: 'XXX', descriptor: 'translation', text: translation });
  expect(lyrics).toContainEqual({ language: 'XXX', descriptor: 'romanization', text: romanization });
});
