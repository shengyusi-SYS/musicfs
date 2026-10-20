import { Buffer } from 'node:buffer';
import type { TagSegment } from './types';

export const ascii = (bytes: Uint8Array, start = 0, end = bytes.length) =>
  String.fromCharCode(...bytes.subarray(start, end));
export const inline = (bytes: Uint8Array): TagSegment => ({ kind: 'bytes', base64: Buffer.from(bytes).toString('base64') });
export const decode = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, 'base64'));
export const segmentSize = (segment: TagSegment): number => segment.kind === 'source'
  ? segment.end - segment.start + 1 : Buffer.byteLength(segment.base64, 'base64');
export const source = (start: number, end: number): TagSegment[] => end < start ? [] : [{ kind: 'source', start, end }];
export function join(chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
