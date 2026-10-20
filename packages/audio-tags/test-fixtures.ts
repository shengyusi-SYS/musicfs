import { ApeTag, ByteVector, FlacBlock, FlacBlockType, Id3v2Tag, Id3v2FrameIdentifiers,
  Picture, PictureType, XiphComment, XiphPicture } from 'node-taglib-sharp';
import type { FileInfo } from '@musicfs/plugin-api';
import type { AudioFormat, ReadRange } from './src';
import { join } from './src/bytes';
import { m4aMetadata } from './test-m4a-metadata';

export const cover = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=', 'base64'));
export const originalLyrics = '[00:00.00]原文\n[00:00.50]第二行\n';
export const translation = '[00:00.00]Translation\n[00:00.50]Second line\n';
export const romanization = '[00:00.00]Yuan wen\n';
const picture = () => Picture.fromFullData(ByteVector.fromByteArray(cover), PictureType.FrontCover, 'image/png', 'existing cover');
export function fixture(format: AudioFormat) {
  const audio = Uint8Array.from({ length: 25600 }, (_, index) => (index * 17) % 251);
  let bytes: Uint8Array;
  let audioStart = 0;
  if (format === 'mp3') {
    const tag = Id3v2Tag.fromEmpty(); tag.version = 4; tag.title = 'Existing title'; tag.album = 'Existing album';
    tag.setTextFrame(Id3v2FrameIdentifiers.TIT3!, 'Existing subtitle'); tag.pictures = [picture()];
    const prefix = tag.render().toByteArray(); audioStart = prefix.length; bytes = join([prefix, audio]);
  } else if (format === 'flac') {
    const tag = XiphComment.fromEmpty(); tag.title = 'Existing title'; tag.album = 'Existing album'; tag.setFieldAsStrings('CUSTOM', 'preserve');
    const prefix = join([new TextEncoder().encode('fLaC'),
      FlacBlock.fromData(FlacBlockType.StreamInfo, ByteVector.fromByteArray(new Uint8Array(34))).render(false).toByteArray(),
      FlacBlock.fromData(FlacBlockType.Application, ByteVector.fromByteArray(new Uint8Array([4, 5, 6, 7]))).render(false).toByteArray(),
      FlacBlock.fromData(FlacBlockType.XiphComment, tag.render(false)).render(false).toByteArray(),
      FlacBlock.fromData(FlacBlockType.Picture, XiphPicture.fromPicture(picture()).renderForFlacBlock()).render(true).toByteArray()]);
    audioStart = prefix.length; bytes = join([prefix, audio]);
  } else if (format === 'm4a') {
    const dataHeader = new Uint8Array(8); new DataView(dataHeader.buffer).setUint32(0, audio.length + 8); dataHeader.set(new TextEncoder().encode('mdat'), 4);
    const free = new Uint8Array([0,0,0,8,102,114,101,101]);
    const ftyp = new Uint8Array(Buffer.from(m4aMetadata.ftyp, 'base64'));
    audioStart = ftyp.length + free.length + dataHeader.length;
    bytes = join([ftyp, free, dataHeader, audio, new Uint8Array(Buffer.from(m4aMetadata.moov, 'base64'))]);
  } else {
    const tag = ApeTag.fromEmpty(); tag.title = 'Existing title'; tag.album = 'Existing album'; tag.setStringValue('CUSTOM', 'preserve'); tag.pictures = [picture()];
    bytes = join([new TextEncoder().encode('MAC '), audio, tag.render().toByteArray()]); audioStart = 4;
  }
  const info: FileInfo = { contentId: `source-${format}-one`, size: bytes.length,
    mediaType: { mp3: 'audio/mpeg', flac: 'audio/flac', ape: 'audio/ape', m4a: 'audio/mp4' }[format] };
  const requests: { start: number; end: number }[] = [];
  const readRange: ReadRange = async (range, signal) => {
    signal.throwIfAborted(); requests.push({ ...range });
    return { content: info, servedRange: range, body: new Blob([bytes.slice(range.start, range.end + 1)]).stream() };
  };
  return { bytes, info, readRange, requests, audioStart, audio };
}
export const parseId3 = (bytes: Uint8Array) => Id3v2Tag.fromData(ByteVector.fromByteArray(bytes));
export const parseApe = (bytes: Uint8Array) => ApeTag.fromData(ByteVector.fromByteArray(bytes));
export function parseFlac(bytes: Uint8Array) {
  const comments: XiphComment[] = [];
  const blocks: { type: number; payload: Uint8Array }[] = [];
  let offset = 4; let last = false;
  while (!last) {
    const type = bytes[offset]! & 127; last = !!(bytes[offset]! & 128);
    const size = bytes[offset + 1]! * 65536 + bytes[offset + 2]! * 256 + bytes[offset + 3]!;
    const payload = bytes.slice(offset + 4, offset + 4 + size); blocks.push({ type, payload });
    if (type === 4) comments.push(XiphComment.fromData(ByteVector.fromByteArray(payload), false));
    offset += size + 4;
  }
  return { comments, blocks, audio: bytes.slice(offset) };
}
// Test consumers share this workspace's private dependency without adding it to the host.
export { Id3v2FrameClassType, Id3v2FrameIdentifiers, Id3v2UnsynchronizedLyricsFrame } from 'node-taglib-sharp';
