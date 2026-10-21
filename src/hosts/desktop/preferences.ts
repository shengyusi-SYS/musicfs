import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { DesktopPreferences } from '../../contracts/desktop';
import { writePrivateJson } from './rclone-control';

export const desktopPreferencesSchema = z.object({
  launchAtLogin: z.boolean().default(true),
  openOnLaunch: z.boolean().default(true),
  openOnLogin: z.boolean().default(false),
  autoMount: z.boolean().default(true),
  retryAutoMount: z.boolean().default(true)
}).strict();

export async function readDesktopPreferences(directory: string): Promise<DesktopPreferences> {
  try { return desktopPreferencesSchema.parse(JSON.parse(await readFile(join(directory, 'preferences.json'), 'utf8'))); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return desktopPreferencesSchema.parse({});
    throw new Error('本机偏好无法读取，请检查 preferences.json。');
  }
}

export async function saveDesktopPreferences(directory: string, settings: DesktopPreferences): Promise<void> {
  await writePrivateJson(join(directory, 'preferences.json'), desktopPreferencesSchema.parse(settings));
}
