import { z } from 'zod';
import { fail } from './client';

export const positiveId = z.union([z.number().int().positive().safe(), z.string().regex(/^[1-9]\d*$/)])
  .transform(value => String(value)).refine(value => Number.isSafeInteger(Number(value)));
const playlist = z.object({ kind: z.literal('playlist'), role: z.enum(['created', 'favorites', 'recommended']), tid: positiveId,
  dirId: z.number().int().positive().max(199).optional() }).strict();
export type PlaylistReference = z.infer<typeof playlist>;
export function playlistRef(value: PlaylistReference): string { return JSON.stringify(playlist.parse(value)); }
export function parsePlaylistRef(value: string): PlaylistReference {
  try { return playlist.parse(JSON.parse(value)); } catch { return fail('not_found', 'QQ 歌单引用无效。'); }
}
