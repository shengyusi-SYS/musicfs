import { z } from 'zod';
import type { FileInfo } from '@musicfs/plugin-api';
import { LibraryError } from './types';

const fileInfo = z.object({ contentId: z.string().min(1), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mediaType: z.string().regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/), modifiedAt: z.iso.datetime({ offset: true }).optional() });

export function assertInfo(info: unknown): asserts info is FileInfo {
  if (!fileInfo.safeParse(info).success) throw new LibraryError('invalid_source', 'Source returned invalid file metadata');
}
