import type { ByteRange, FileInfo, PluginFault, ReadResult } from '@musicfs/plugin-api';

export type AudioFormat = 'mp3' | 'flac' | 'ape' | 'm4a';
export type AudioTags = {
  title?: string;
  artists?: string[];
  album?: string;
  albumArtists?: string[];
  date?: string;
  track?: { number: number; total?: number };
  disc?: { number: number; total?: number };
  cover?: { mimeType: string; data: Uint8Array; description?: string };
  lyrics?: { original?: string; translation?: string; romanization?: string };
};
export type ReadRange = ((range: ByteRange, signal: AbortSignal) => Promise<ReadResult>) & {
  /** Optional preparation optimization. Results correspond to the requested closed ranges in order. */
  readMany?: (ranges: readonly ByteRange[], signal: AbortSignal) => Promise<ReadResult[]>;
};
export type TagSegment =
  | { kind: 'bytes'; base64: string }
  | { kind: 'source'; start: number; end: number };
/** Cacheable exact byte description; source ranges are inclusive and contain no locator. */
export type TaggedPlan = {
  version: 1;
  format: AudioFormat;
  source: FileInfo;
  content: FileInfo;
  segments: TagSegment[];
};
export type PrepareOptions = {
  format: AudioFormat;
  sourceInfo: FileInfo;
  readRange: ReadRange;
  tags: AudioTags;
  signal: AbortSignal;
};
export class AudioTagError extends Error {
  constructor(readonly kind: PluginFault['kind'], message: string) {
    super(message);
    this.name = 'AudioTagError';
  }
}
