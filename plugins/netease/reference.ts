import type { FileInfo } from '@musicfs/plugin-api';
import { z } from 'zod';
import { fail } from './client';
import { qualities } from './configuration';

export const reference = z.object({ version: z.literal(1), id: z.string().regex(/^[1-9]\d*$/), level: z.enum(qualities), type: z.enum(['mp3', 'flac', 'm4a']), md5: z.string().regex(/^[a-fA-F0-9]{32}$/), size: z.number().int().positive().safe() }).strict();
export type MediaReference = z.infer<typeof reference>;
const mime = { mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4' };
export function decodeFile(file: string): MediaReference {
  let value: unknown; try { value = JSON.parse(file); } catch { fail('not_found', '无效的网易云文件引用。'); }
  const parsed = reference.safeParse(value); if (!parsed.success) fail('not_found', '无效的网易云文件引用。'); return parsed.data;
}
export const info = (ref: MediaReference): FileInfo => ({ contentId: JSON.stringify([ref.id, ref.level, ref.type, ref.md5.toLowerCase(), ref.size]), size: ref.size, mediaType: mime[ref.type] });
