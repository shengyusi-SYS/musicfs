import {
  ByteVector, Id3v2Tag, Id3v2FrameClassType, Id3v2FrameIdentifiers,
  Id3v2UnsynchronizedLyricsFrame, Id3v2TagHeaderFlags, Picture, PictureType, StringType,
} from 'node-taglib-sharp';
import type { Tag } from 'node-taglib-sharp';
import type { AudioTags } from './types';

export function applyTags(tag: Tag, tags: AudioTags, includeCover = true): void {
  if (tags.title !== undefined) tag.title = tags.title;
  if (tags.artists !== undefined) tag.performers = [...tags.artists];
  if (tags.album !== undefined) tag.album = tags.album;
  if (tags.albumArtists !== undefined) tag.albumArtists = [...tags.albumArtists];
  if (tags.track !== undefined) {
    tag.track = tags.track.number;
    if (tags.track.total !== undefined) tag.trackCount = tags.track.total;
  }
  if (tags.disc !== undefined) {
    tag.disc = tags.disc.number;
    if (tags.disc.total !== undefined) tag.discCount = tags.disc.total;
  }
  if (includeCover && tags.cover !== undefined) tag.pictures = [Picture.fromFullData(
    ByteVector.fromByteArray(tags.cover.data), PictureType.FrontCover, tags.cover.mimeType,
    tags.cover.description ?? '',
  )];
}
export function id3Lyrics(tag: Id3v2Tag, lyrics: NonNullable<AudioTags['lyrics']>): void {
  const frames = tag.getFramesByClassType<Id3v2UnsynchronizedLyricsFrame>(Id3v2FrameClassType.UnsynchronizedLyricsFrame);
  for (const [kind, text] of Object.entries(lyrics)) {
    if (text === undefined) continue;
    const description = kind === 'original' ? '' : kind;
    const matches = frames.filter(frame => frame.description === description);
    if (matches.length) {
      for (const frame of matches) { frame.text = text; frame.textEncoding = StringType.UTF16; }
    } else {
      const frame = Id3v2UnsynchronizedLyricsFrame.fromData(description, 'XXX', StringType.UTF16);
      frame.text = text;
      tag.addFrame(frame);
    }
  }
}
export function applyId3(tag: Id3v2Tag, tags: AudioTags): void {
  const existingDate = tag.getTextAsString(Id3v2FrameIdentifiers.TDRC!);
  tag.flags &= ~Id3v2TagHeaderFlags.FooterPresent;
  tag.version = 3;
  applyTags(tag, tags);
  const date = tags.date ?? existingDate;
  if (tags.date !== undefined || existingDate) {
    // Set v2.3 native date frames explicitly; do not rely on the library's v2.4 date conversion.
    const parts = /^(\d{4})(?:-(\d{2})-(\d{2}))?/.exec(date);
    tag.setTextFrame(Id3v2FrameIdentifiers.TYER!, parts?.[1] ?? '');
    tag.setTextFrame(Id3v2FrameIdentifiers.TDAT!, parts?.[2] && parts[3] ? parts[3] + parts[2] : '');
  }
  if (tags.lyrics !== undefined) id3Lyrics(tag, tags.lyrics);
  // UTF-16 with BOM is valid in v2.3, including when replacing legacy Latin-1 text with Chinese.
  for (const frame of tag.frames) if ('textEncoding' in frame) frame.textEncoding = StringType.UTF16;
}
