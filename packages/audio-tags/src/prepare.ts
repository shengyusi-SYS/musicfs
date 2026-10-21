import { ByteVector, Id3v1Tag, Id3v2Tag, Id3v2TagHeaderFlags, ApeTag, FlacBlock, FlacBlockType, XiphComment, XiphPicture } from 'node-taglib-sharp';
import { AudioTagError, AudioReservationError, type PrepareOptions, type TaggedPlan, type TagSegment } from './types';
import { ascii, decode, inline, segmentSize, source } from './bytes';
import { readBytes, bufferedRanges } from './read';
import { applyId3, applyTags } from './tags';
import { prepareM4a } from './m4a';

async function leadingId3(options: PrepareOptions): Promise<{ size: number; tag: Id3v2Tag | undefined }> {
  if (options.sourceInfo.size < 10) return { size: 0, tag: undefined };
  const header = await readBytes(options, 0, 9);
  if (ascii(header, 0, 3) !== 'ID3') return { size: 0, tag: undefined };
  if (header.subarray(6, 10).some(byte => byte >= 128)) throw new AudioTagError('not_supported', 'Invalid ID3 tag size.');
  const length = header.subarray(6, 10).reduce((size, byte) => size * 128 + byte, 0);
  const size = 10 + length + (header[3] === 4 && (header[5]! & 16) ? 10 : 0);
  return { size, tag: Id3v2Tag.fromData(ByteVector.fromByteArray(await readBytes(options, 0, size - 1))) };
}
async function trailingId3(options: PrepareOptions): Promise<{ end: number; tag: Id3v1Tag | undefined }> {
  const size = options.sourceInfo.size;
  if (size < 128) return { end: size, tag: undefined };
  const data = await readBytes(options, size - 128, size - 1);
  return ascii(data, 0, 3) === 'TAG'
    ? { end: size - 128, tag: Id3v1Tag.fromData(ByteVector.fromByteArray(data)) }
    : { end: size, tag: undefined };
}
async function mp3(options: PrepareOptions): Promise<TagSegment[]> {
  const leading = await leadingId3(options);
  const trailing = await trailingId3(options);
  const tag = leading.tag ?? Id3v2Tag.fromEmpty();
  trailing.tag?.copyTo(tag, false);
  applyId3(tag, options.tags);
  // Render ordinary v2.3 frame lengths, so library-generated padding can remain a compact zero segment.
  if (options.reserveBytes !== undefined) tag.flags &= ~Id3v2TagHeaderFlags.Unsynchronization;
  const rendered = tag.render().toByteArray();
  const audio = source(leading.size, trailing.end - 1);
  if (options.reserveBytes === undefined) return [inline(rendered), ...audio];
  let frameEnd = 10;
  while (frameEnd + 10 <= rendered.length && rendered[frameEnd] !== 0) {
    const size = new DataView(rendered.buffer, rendered.byteOffset + frameEnd + 4, 4).getUint32(0);
    frameEnd += 10 + size;
    if (frameEnd > rendered.length) throw new AudioTagError('not_supported', 'Invalid rendered ID3 frame length.');
  }
  const regionSize = options.sourceInfo.size + options.reserveBytes - (trailing.end - leading.size);
  if (regionSize < frameEnd) throw new AudioReservationError('Audio metadata exceeds the reserved extra-byte budget.');
  if (regionSize - 10 > 0x0fffffff) throw new AudioTagError('not_supported', 'The reserved ID3 tag exceeds its format size limit.');
  const prefix = rendered.slice(0, frameEnd);
  let size = regionSize - 10;
  for (let index = 9; index >= 6; index--) { prefix[index] = size & 127; size = Math.floor(size / 128); }
  return [inline(prefix), ...(regionSize > frameEnd ? [{ kind: 'zeros' as const, size: regionSize - frameEnd }] : []), ...audio];
}
async function flac(options: PrepareOptions): Promise<TagSegment[]> {
  const leading = await leadingId3(options);
  const marker = await readBytes(options, leading.size, leading.size + 3);
  if (ascii(marker) !== 'fLaC') throw new AudioTagError('not_supported', 'This source is not a FLAC stream.');
  const retained: TagSegment[] = [inline(marker)];
  let comment: XiphComment | undefined;
  let offset = leading.size + 4;
  let last = false;
  let first = true;
  while (!last) {
    const header = await readBytes(options, offset, offset + 3);
    const type = header[0]! & 127;
    last = !!(header[0]! & 128);
    const size = header[1]! * 65536 + header[2]! * 256 + header[3]!;
    if (offset + 4 + size > options.sourceInfo.size || (first && (type !== FlacBlockType.StreamInfo || size !== 34))) {
      throw new AudioTagError('not_supported', 'Invalid FLAC metadata block.');
    }
    first = false;
    if (type === FlacBlockType.XiphComment) {
      const data = await readBytes(options, offset + 4, offset + 3 + size);
      const parsed = XiphComment.fromData(ByteVector.fromByteArray(data), false);
      if (!comment) comment = parsed;
      else parsed.copyTo(comment, false);
    } else if (type !== FlacBlockType.Picture || options.tags.cover === undefined) {
      // Only this header flag changes when another metadata block follows it.
      if (last) retained.push(inline(new Uint8Array([type])), ...source(offset + 1, offset + 3 + size));
      else retained.push(...source(offset, offset + 3 + size));
    }
    offset += 4 + size;
  }
  comment ??= XiphComment.fromEmpty();
  leading.tag?.copyTo(comment, false);
  applyTags(comment, options.tags, false);
  if (options.tags.cover !== undefined) comment.pictures = [];
  if (options.tags.date !== undefined) comment.setFieldAsStrings('DATE', options.tags.date);
  for (const [kind, text] of Object.entries(options.tags.lyrics ?? {})) {
    if (text !== undefined) comment.setFieldAsStrings(kind === 'original' ? 'LYRICS' : `LYRICS_${kind.toUpperCase()}`, text);
  }
  const picture = options.tags.cover;
  const commentBlock = FlacBlock.fromData(FlacBlockType.XiphComment, comment.render(false));
  retained.push(inline(commentBlock.render(picture === undefined).toByteArray()));
  if (picture !== undefined) {
    const image = XiphPicture.fromPicture({
      data: ByteVector.fromByteArray(picture.data), type: 3, mimeType: picture.mimeType,
      description: picture.description ?? '', filename: '',
    });
    retained.push(inline(FlacBlock.fromData(FlacBlockType.Picture, image.renderForFlacBlock()).render(true).toByteArray()));
  }
  const audio = source(offset, options.sourceInfo.size - 1);
  if (options.reserveBytes === undefined) return [...retained, ...audio];
  let remaining = options.sourceInfo.size + options.reserveBytes
    - [...retained, ...audio].reduce((size, part) => size + segmentSize(part), 0);
  if (remaining === 0) return [...retained, ...audio];
  if (remaining < 4) throw new AudioReservationError('Audio metadata exceeds the reserved extra-byte budget including FLAC padding.');
  const finalBlock = retained.at(-1)!;
  if (finalBlock.kind !== 'bytes') throw new AudioTagError('not_supported', 'Missing final FLAC metadata block.');
  const finalBytes = decode(finalBlock.base64); finalBytes[0]! &= 127;
  retained[retained.length - 1] = inline(finalBytes);
  while (remaining > 0) {
    let total = Math.min(remaining, 0xffffff + 4);
    // Leave enough room for the next block's four-byte header.
    if (remaining > total && remaining - total < 4) total -= 4 - (remaining - total);
    const payload = total - 4; remaining -= total;
    retained.push(inline(new Uint8Array([remaining === 0 ? 0x81 : 1, payload >>> 16, payload >>> 8 & 255, payload & 255])));
    if (payload > 0) retained.push({ kind: 'zeros', size: payload });
  }
  return [...retained, ...audio];
}
async function ape(options: PrepareOptions): Promise<TagSegment[]> {
  const leading = await leadingId3(options);
  if (ascii(await readBytes(options, leading.size, leading.size + 3)) !== 'MAC ') {
    throw new AudioTagError('not_supported', 'This source is not a Monkey’s Audio stream.');
  }
  const trailing = await trailingId3(options);
  let end = trailing.end;
  let tag = ApeTag.fromEmpty();
  if (end >= 32) {
    const footer = await readBytes(options, end - 32, end - 1);
    if (ascii(footer, 0, 8) === 'APETAGEX') {
      const view = new DataView(footer.buffer, footer.byteOffset, footer.byteLength);
      const size = view.getUint32(12, true) + (view.getUint32(20, true) & 0x80000000 ? 32 : 0);
      if (size < 32 || end - size < leading.size) throw new AudioTagError('not_supported', 'Invalid APE tag size.');
      tag = ApeTag.fromData(ByteVector.fromByteArray(await readBytes(options, end - size, end - 1)));
      end -= size;
    }
  }
  leading.tag?.copyTo(tag, false);
  trailing.tag?.copyTo(tag, false);
  applyTags(tag, options.tags);
  if (options.tags.date !== undefined) tag.setStringValue('Year', options.tags.date);
  for (const [kind, text] of Object.entries(options.tags.lyrics ?? {})) {
    if (text !== undefined) tag.setStringValue(kind === 'original' ? 'Lyrics' : `Lyrics${kind[0]!.toUpperCase()}${kind.slice(1)}`, text);
  }
  return [...source(leading.size, end - 1), inline(tag.render().toByteArray())];
}
export async function prepare(options: PrepareOptions): Promise<TaggedPlan> {
  options.signal.throwIfAborted();
  if (options.reserveBytes !== undefined) {
    if (!Number.isSafeInteger(options.reserveBytes) || options.reserveBytes < 0
      || !Number.isSafeInteger(options.sourceInfo.size + options.reserveBytes)) {
      throw new RangeError('Reserved audio bytes must be a non-negative safe integer within the final file size.');
    }
    if (options.format === 'ape') throw new AudioTagError('not_supported', 'Fixed-size audio tag reservation is not supported for APE.');
  }
  const encoders = { mp3, flac, ape, m4a: prepareM4a };
  if (!encoders[options.format]) throw new AudioTagError('not_supported', 'Audio tag generation is not supported for this format.');
  const generated = await encoders[options.format]({ ...options, readRange: bufferedRanges(options) });
  const segments: TagSegment[] = [];
  for (const segment of generated) {
    const previous = segments.at(-1);
    if (previous?.kind === 'source' && segment.kind === 'source' && previous.end + 1 === segment.start) previous.end = segment.end;
    else segments.push(segment);
  }
  const size = segments.reduce((total, segment) => total + segmentSize(segment), 0);
  const description = { version: 1 as const, format: options.format, source: { ...options.sourceInfo }, segments };
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(description))));
  const contentId = `audio-tags-v1:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  return { ...description, content: { contentId, size, mediaType: { mp3: 'audio/mpeg', flac: 'audio/flac', ape: 'audio/x-ape', m4a: 'audio/mp4' }[options.format] } };
}
