import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { disposeSync, jsonLinesFormatter } from '@logtape/logtape';
import { getRotatingFileSink } from '@logtape/file';
import { configureApplicationLogging } from '../../infrastructure/logging';

export async function configureDesktopLogging(directory: string) {
  const folder = join(directory, 'logs');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, 'musicfs.log');
  const file = getRotatingFileSink(path, { formatter: jsonLinesFormatter, maxSize: 2 * 1024 * 1024, maxFiles: 3, bufferSize: 0 });
  if (process.platform !== 'win32') await chmod(path, 0o600);
  configureApplicationLogging({ file }, process.env.MUSICFS_LOG_LEVEL);
  return disposeSync;
}
