import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { disposeSync, getConsoleSink, getLogger, jsonLinesFormatter, type Sink } from '@logtape/logtape';
import { getRotatingFileSink } from '@logtape/file';
import { configureApplicationLogging, errorFields } from '../../infrastructure/logging';

export async function configureDesktopLogging(directory: string) {
  const folder = join(directory, 'logs');
  const path = join(folder, 'musicfs.log');
  let file: (Sink & Disposable) | undefined;
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    file = getRotatingFileSink(path, { formatter: jsonLinesFormatter, maxSize: 2 * 1024 * 1024, maxFiles: 3, bufferSize: 0 });
    if (process.platform !== 'win32') await chmod(path, 0o600);
    configureApplicationLogging({ file }, process.env.MUSICFS_LOG_LEVEL);
  } catch (error) {
    if (file && Symbol.dispose in file) file[Symbol.dispose]();
    configureApplicationLogging({ console: getConsoleSink({ formatter: jsonLinesFormatter }) }, process.env.MUSICFS_LOG_LEVEL);
    getLogger(['musicfs', 'desktop']).warning('File logging unavailable; using process output', errorFields(error));
  }
  return disposeSync;
}
