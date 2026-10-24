import { chmod, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { disposeSync, getConsoleSink, getLogger, isLogLevel, jsonLinesFormatter, type Sink } from '@logtape/logtape';
import { getRotatingFileSink } from '@logtape/file';
import { BlobReader, BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js/index-native.js';
import { z } from 'zod';
import { version } from '../../../package.json';
import { diagnosticLevels, nativeLogLevels, type DesktopDiagnosticsView, type DiagnosticSettings, type NativeLogLevel } from '../../contracts/diagnostics';
import { configureApplicationLogging, errorFields } from '../../infrastructure/logging';
import { writePrivateJson } from './rclone-control';

export const diagnosticSettingsSchema = z.object({ level: z.enum(diagnosticLevels), nativeLevel: z.enum(nativeLogLevels) }).strict();
export type DesktopLogging = Awaited<ReturnType<typeof configureDesktopLogging>>;
declare const MUSICFS_BUILD_REVISION: string;
const revision = typeof MUSICFS_BUILD_REVISION === 'string' ? MUSICFS_BUILD_REVISION : 'source';

/** Owns sinks and preferences; changing verbosity never replaces an open sink or restarts the backend. */
export async function configureDesktopLogging(directory: string) {
  const folder = join(directory, 'logs'); const path = join(folder, 'musicfs.log');
  const settingsPath = join(directory, 'diagnostics.json');
  const environmentLevel = process.env.MUSICFS_LOG_LEVEL;
  let settings: DiagnosticSettings = { level: environmentLevel && isLogLevel(environmentLevel) ? environmentLevel : 'info', nativeLevel: 'ERROR' };
  let settingsError: unknown;
  try { settings = diagnosticSettingsSchema.parse(JSON.parse(await readFile(settingsPath, 'utf8'))); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) settingsError = error; }
  let file: (Sink & Disposable) | undefined; let fileError: unknown;
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    file = getRotatingFileSink(path, { formatter: jsonLinesFormatter, maxSize: 2 * 1024 * 1024, maxFiles: 3, bufferSize: 0 });
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } catch (error) {
    file?.[Symbol.dispose](); file = undefined; fileError = error;
  }
  const runtime = configureApplicationLogging(file ? { file } : { console: getConsoleSink({ formatter: jsonLinesFormatter }) }, settings.level);
  const logger = getLogger(['musicfs', 'desktop']);
  if (fileError) logger.warning('File logging unavailable; using process output', errorFields(fileError));
  if (settingsError) logger.warning('Log settings unavailable; using startup defaults', errorFields(settingsError));
  const startedAt = new Date().toISOString();
  logger.info('Application logging started', { version, revision, pid: process.pid, startedAt, level: settings.level, nativeLevel: settings.nativeLevel });
  let native: ((level: NativeLogLevel) => Promise<void>) | undefined;
  const inspect = (): DesktopDiagnosticsView => ({ settings: { ...settings }, version, revision, startedAt, directory: folder, fileLogging: !!file,
    nativeAvailable: native !== undefined });
  return {
    inspect,
    attachNative(configure: (level: NativeLogLevel) => Promise<void>) { native = configure; },
    async configure(next: DiagnosticSettings) {
      next = diagnosticSettingsSchema.parse(next);
      const previous = settings;
      if (next.nativeLevel !== previous.nativeLevel) await native?.(next.nativeLevel);
      try { await writePrivateJson(settingsPath, next); }
      catch (error) {
        if (next.nativeLevel !== previous.nativeLevel) await native?.(previous.nativeLevel).catch(cause => logger.warning('Native log level restore failed', errorFields(cause)));
        throw error;
      }
      runtime.setLevel(next.level); settings = next;
      logger.info('Log settings changed', { level: settings.level, nativeLevel: settings.nativeLevel });
      return inspect();
    },
    async archive(): Promise<Blob> {
      const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false, bufferedWrite: false, level: 6 });
      const entries: { file: string; bytes: number; truncated: boolean }[] = [];
      const locations = [
        { directory: folder, prefix: 'application', match: /^musicfs\.log(?:\.\d+)?$/ },
        { directory: join(directory, 'mounts'), prefix: 'native', match: /^rclone(?:-\d[^/]*)?\.log(?:\.\d+)?$/ },
        { directory, prefix: 'startup', match: /^(?:startup|launcher)\.log$/ }
      ];
      try {
        for (const location of locations) {
          let names: string[];
          try { names = await readdir(location.directory); }
          catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue; throw error; }
          for (const name of names.filter(name => location.match.test(name)).sort().slice(-4)) {
            const input = Bun.file(join(location.directory, name));
            if (!await input.exists()) continue;
            const size = input.size; const maximum = 2 * 1024 * 1024;
            const blob = input.slice(Math.max(0, size - maximum), size);
            await writer.add(`${location.prefix}/${name}`, new BlobReader(blob));
            entries.push({ file: `${location.prefix}/${name}`, bytes: blob.size, truncated: size > maximum });
          }
        }
        await writer.add('diagnostics.json', new TextReader(JSON.stringify({ version, revision, startedAt, exportedAt: new Date().toISOString(),
          pid: process.pid, platform: process.platform, settings, fileLogging: !!file, files: entries }, null, 2)));
        return await writer.close();
      } catch (error) { await writer.close().catch(() => {}); throw error; }
    },
    close() { logger.info('Application logging stopped', { version, pid: process.pid }); disposeSync(); }
  };
}
