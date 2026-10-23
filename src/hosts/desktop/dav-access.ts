import { t } from './locale';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DavAccess, DavCredentials } from '../../contracts/dav-access';
import { writePrivateJson } from './rclone-control';

/** Only public DAV credentials change; the launcher's identity and internal cache stay independent. */
export async function createDesktopDavAccess(directory: string, defaults: DavCredentials) {
  const path = join(directory, 'dav.json');
  let current = { ...defaults };
  try { current = JSON.parse(await readFile(path, 'utf8')) as DavCredentials; }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error(t("WebDAV 连接设置无法读取，请检查 dav.json。")); }
  if (typeof current.username !== 'string' || !current.username || current.username.includes(':') || typeof current.password !== 'string' || !current.password) {
    throw new Error(t("WebDAV 连接设置无效，请检查 dav.json。"));
  }
  return {
    get: () => ({ ...current }),
    async save(value) { await writePrivateJson(path, value); current = { ...value }; }
  } satisfies DavAccess;
}
