import { ByteVector, File, Mpeg4AppleDataBoxFlagType, Mpeg4AppleTag, Mpeg4BoxHeader,
  Mpeg4BoxType, Mpeg4IsoUserDataBox, Mpeg4IsoMetaBox, ReadStyle, StringType, TagTypes } from 'node-taglib-sharp';
import type { IStream } from 'node-taglib-sharp';
import Mpeg4BoxRenderer from 'node-taglib-sharp/dist/mpeg4/mpeg4BoxRenderer';
import { AudioTagError, type AudioTags, type PrepareOptions, type TagSegment } from './types';
import { ascii, inline, join, source } from './bytes';
import { readBytes } from './read';
import { applyTags } from './tags';

type Box = { type: string; start: number; size: number; headerSize: number; header: Uint8Array };
function header(bytes: Uint8Array, start: number, available: number): Box {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(0);
  const size = declared === 0 ? available : declared === 1 ? Number(view.getBigUint64(8)) : declared;
  const headerSize = declared === 1 ? 16 : 8;
  if (!Number.isSafeInteger(size) || size < headerSize || size > available) {
    throw new AudioTagError('not_supported', 'Invalid M4A box length.');
  }
  return { type: ascii(bytes, 4, 8), start, size, headerSize, header: bytes.slice(0, headerSize) };
}
function children(bytes: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  for (let offset = start; offset < end;) {
    if (end - offset < 8) throw new AudioTagError('not_supported', 'Incomplete M4A box header.');
    const box = header(bytes.subarray(offset, Math.min(offset + 16, end)), offset, end - offset);
    boxes.push(box); offset += box.size;
  }
  return boxes;
}
function box(type: string, data: Uint8Array): Uint8Array {
  const descriptor = Mpeg4BoxHeader.fromType(ByteVector.fromString(type, StringType.Latin1));
  descriptor.dataSize = data.length;
  return join([descriptor.render().toByteArray(), data]);
}
/** Only the small ftyp/udta editing container uses this stream; source media never enters it. */
class MetadataStream implements IStream {
  readonly canWrite = true;
  position = 0;
  constructor(public data: Uint8Array) {}
  get length() { return this.data.length; }
  close() {}
  read(target: Uint8Array, offset: number, length: number) {
    const count = Math.max(0, Math.min(length, this.length - this.position));
    target.set(this.data.subarray(this.position, this.position + count), offset);
    this.position += count; return count;
  }
  seek(offset: number, origin: number) { this.position = offset + (origin === 1 ? this.position : origin === 2 ? this.length : 0); }
  setLength(length: number) {
    if (length === this.length) return;
    const bytes = new Uint8Array(length); bytes.set(this.data.subarray(0, length)); this.data = bytes;
  }
  write(value: Uint8Array | ByteVector, offset: number, length: number) {
    const bytes = value instanceof Uint8Array ? value : value.toByteArray();
    if (this.position + length > this.length) this.setLength(this.position + length);
    this.data.set(bytes.subarray(offset, offset + length), this.position); this.position += length; return length;
  }
}
function existingOrEmptyUserData(existing: Uint8Array | undefined): Uint8Array {
  if (existing) {
    const parent = header(existing, 0, existing.length);
    if (children(existing, parent.headerSize, parent.size).some(item => item.type === 'meta')) return existing;
  }
  // Supply an explicit handler name: the pinned library's implicit empty-meta path leaves it undefined.
  const meta = Mpeg4IsoMetaBox.fromHandler(ByteVector.fromString('mdir', StringType.Latin1), 'MusicFS');
  if (existing) {
    const parent = header(existing, 0, existing.length);
    return box('udta', join([existing.subarray(parent.headerSize), Mpeg4BoxRenderer.renderBox(meta).toByteArray()]));
  }
  const empty = Mpeg4IsoUserDataBox.fromEmpty(); empty.addChild(meta);
  return Mpeg4BoxRenderer.renderBox(empty).toByteArray();
}
function updateUserData(ftyp: Uint8Array, existing: Uint8Array | undefined, tags: AudioTags): Uint8Array {
  const stream = new MetadataStream(join([ftyp, box('moov', existingOrEmptyUserData(existing))]));
  const file = File.createFromAbstraction({ name: 'metadata.m4a', get readStream() { stream.position = 0; return stream; },
    get writeStream() { stream.position = 0; return stream; }, closeStream() {} }, 'taglib/m4a', ReadStyle.None);
  try {
    const tag = file.getTag(TagTypes.Apple, true) as Mpeg4AppleTag;
    applyTags(tag, tags);
    const textValues = (values: string[]) => values.map(value => ByteVector.fromString(value, StringType.UTF8));
    if (tags.artists !== undefined) tag.setQuickTimeData(Mpeg4BoxType.ART, textValues(tags.artists), Mpeg4AppleDataBoxFlagType.ContainsText);
    if (tags.albumArtists !== undefined) tag.setQuickTimeData(Mpeg4BoxType.AART, textValues(tags.albumArtists), Mpeg4AppleDataBoxFlagType.ContainsText);
    if (tags.date !== undefined) tag.setQuickTimeString(Mpeg4BoxType.DAY, tags.date);
    if (tags.lyrics?.original !== undefined) tag.lyrics = tags.lyrics.original;
    if (tags.lyrics?.translation !== undefined) tag.setItunesStrings('com.apple.iTunes', 'LYRICS_TRANSLATION', tags.lyrics.translation);
    if (tags.lyrics?.romanization !== undefined) tag.setItunesStrings('com.apple.iTunes', 'LYRICS_ROMANIZATION', tags.lyrics.romanization);
    file.save();
    const movie = children(stream.data, 0, stream.length).find(item => item.type === 'moov');
    const data = movie && children(stream.data, movie.start + movie.headerSize, movie.start + movie.size).find(item => item.type === 'udta');
    if (!data) throw new AudioTagError('not_supported', 'The tag library could not write M4A user data.');
    return stream.data.slice(data.start, data.start + data.size);
  } finally { file.dispose(); }
}

/** Keep every media offset fixed: retire old moov as equal-sized free space, append the new moov. */
export async function prepareM4a(options: PrepareOptions): Promise<TagSegment[]> {
  const top: Box[] = [];
  for (let offset = 0; offset < options.sourceInfo.size;) {
    const first = await readBytes(options, offset, offset + 7);
    const bytes = new DataView(first.buffer).getUint32(0) === 1
      ? join([first, await readBytes(options, offset + 8, offset + 15)]) : first;
    const item = header(bytes, offset, options.sourceInfo.size - offset);
    top.push(item); offset += item.size;
  }
  const movies = top.filter(item => item.type === 'moov');
  const movie = movies[0]; const ftyp = top.find(item => item.type === 'ftyp');
  if (movies.length !== 1 || !movie || !ftyp || top.some(item => item.type === 'moof')) {
    throw new AudioTagError('not_supported', 'Audio tags require a non-fragmented M4A file with one movie box.');
  }
  const movieBytes = await readBytes(options, movie.start, movie.start + movie.size - 1);
  const movieChildren = children(movieBytes, movie.headerSize, movie.size);
  if (movieChildren.some(item => item.type === 'mvex') || movieChildren.filter(item => item.type === 'udta').length > 1) {
    throw new AudioTagError('not_supported', 'This M4A movie metadata layout is not supported.');
  }
  const userData = movieChildren.find(item => item.type === 'udta');
  const updated = updateUserData(await readBytes(options, ftyp.start, ftyp.start + ftyp.size - 1),
    userData ? movieBytes.slice(userData.start, userData.start + userData.size) : undefined, options.tags);
  const payload = movieChildren.map(item => item === userData ? updated : movieBytes.subarray(item.start, item.start + item.size));
  if (!userData) payload.push(updated);
  const newMovie = box('moov', join(payload));
  const patches = top.filter(item => item === movie || new DataView(item.header.buffer).getUint32(0) === 0).map(item => {
    const bytes = item.header.slice(); const view = new DataView(bytes.buffer);
    if (view.getUint32(0) === 0) {
      if (item.size > 0xffffffff) throw new AudioTagError('not_supported', 'An open-ended M4A box is too large to retain its original header.');
      view.setUint32(0, item.size);
    }
    if (item === movie) bytes.set(new TextEncoder().encode('free'), 4);
    return { start: item.start, bytes };
  });
  const segments: TagSegment[] = [];
  let offset = 0;
  for (const patch of patches) {
    segments.push(...source(offset, patch.start - 1), inline(patch.bytes)); offset = patch.start + patch.bytes.length;
  }
  return [...segments, ...source(offset, options.sourceInfo.size - 1), inline(newMovie)];
}
