import type { FileInfo } from '@musicfs/plugin-api';
import type { Quality } from './configuration';

export const formats = {
  flac: { label: 'FLAC', mediaType: 'audio/flac' }, ape: { label: 'APE', mediaType: 'audio/x-ape' },
  '320': { label: '320k', mediaType: 'audio/mpeg' }, '128': { label: '128k', mediaType: 'audio/mpeg' }, m4a: { label: 'M4A', mediaType: 'audio/mp4' }
} as const;

/** Only actual response headers describe bytes; track size_* values are availability hints. */
export function describe(response: Response, ref: { filename: string; quality: Quality }, partial: boolean): FileInfo | null {
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding !== 'identity') return null;
  const matched = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  const raw = partial ? matched?.[3] : response.headers.get('content-length');
  const size = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  const revision = response.headers.get('etag') ?? response.headers.get('last-modified');
  if (!Number.isSafeInteger(size) || size <= 0 || !revision) return null;
  return { contentId: JSON.stringify([ref.filename, size, revision]), size, mediaType: formats[ref.quality].mediaType };
}
