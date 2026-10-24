import { t } from './locale';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LRUCache } from 'lru-cache';
import { z } from 'zod';
import type { ReadResult } from '@musicfs/plugin-api';
import type { ReadCacheManager, ReadCacheSettings, ReadCacheStatus } from '../../contracts/read-cache';
import { LibraryError, type Description, type FileDescription, type FileView } from '../../core/library';
import { createDav, type ReadCredentials } from '../../transport/dav';
import { MountError, writePrivateJson, type RcloneControl } from './rclone-control';
import { CACHE_YEAR_HOURS, SHARED_READ_CACHE_MIB } from '../../contracts/cache-defaults';
import { getLogger, withContext } from '@logtape/logtape';
import { observeFetch } from '../../infrastructure/io-diagnostics';

const settingsSchema = z.object({ maxMiB: z.number().int().min(0).max(1_048_576), maxAgeHours: z.number().int().min(0).max(2_147_483) }).strict();
const storedSettingsSchema = settingsSchema.extend({ cacheDefaultsVersion: z.literal(1).optional() });
const defaults: ReadCacheSettings = { maxMiB: SHARED_READ_CACHE_MIB, maxAgeHours: CACHE_YEAR_HOURS };
const remote = 'musicfs_shared_reads';
const logger = getLogger(['musicfs', 'io', 'cache']);
const cacheFetch = observeFetch(fetch, 'cache');
const fixedTime = '2000-01-01T00:00:00.000Z';
const directory = (path: string): Description => ({ kind: 'directory', path, name: path.split('/').at(-1) ?? '', etag: path, modifiedAt: fixedTime });
const bucketNames = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const statsSchema = z.object({ opt: z.object({ CacheMode: z.union([z.literal('full'), z.literal('off'), z.literal(0), z.literal(3)]) }),
  diskCache: z.object({ path: z.string(), bytesUsed: z.number().nonnegative(), files: z.number().nonnegative() }).optional() });

/** Desktop adapter: immutable file keys and read gates here; sparse storage/eviction stay in rclone. */
export async function createDesktopReadCache(input: {
  directory: string; controlDirectory: string; control: RcloneControl; view: FileView;
  current(file: FileDescription): boolean | Promise<boolean>;
}): Promise<ReadCacheManager & { files: FileView; mountConnection: ReadCredentials & { url: string }; prepareQuit(): () => void; close(): Promise<void> }> {
  await mkdir(input.directory, { recursive: true });
  const settingsPath = join(input.directory, 'settings.json');
  let settings: ReadCacheSettings;
  const persistSettings = (value: ReadCacheSettings) => writePrivateJson(settingsPath, { ...value, cacheDefaultsVersion: 1 });
  try {
    const saved = storedSettingsSchema.parse(JSON.parse(await readFile(settingsPath, 'utf8')));
    settings = { maxMiB: saved.maxMiB, maxAgeHours: saved.cacheDefaultsVersion === undefined && saved.maxAgeHours === 168 ? CACHE_YEAR_HOURS : saved.maxAgeHours };
    if (saved.cacheDefaultsVersion === undefined) await persistSettings(settings);
  }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new MountError('mount_failed', t("WebDAV 读取缓存设置无法读取，请保留数据并检查设置文件。"));
    settings = { ...defaults }; await persistSettings(settings);
  }
  const cacheDirectory = join(input.controlDirectory, 'cache', 'vfs', remote);
  const credentials = { username: 'musicfs-cache', password: crypto.randomUUID() + crypto.randomUUID() };
  const entries = new LRUCache<string, FileDescription>({ max: 8192 });
  const pinned = new Map<string, { file: FileDescription; readers: number }>();
  const failures = new LRUCache<string, LibraryError>({ max: 1024 });
  let running: { id: string; address: string } | undefined;
  let starting: Promise<void> | undefined;
  let active = 0, closed = false, remoteCreated = false, accepting = true;
  let management: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = management.then(work); management = next.catch(() => {}); return next;
  };
  const assertCurrent = async (file: FileDescription, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!await input.current(file)) throw new LibraryError('stale_call', 'Source changed before cached audio request');
    signal.throwIfAborted();
  };
  const keyFor = (file: FileDescription) => {
    const { stamp, fileRef, content } = file.handle;
    return new Bun.CryptoHasher('sha256').update(JSON.stringify([stamp.id, stamp.epoch, stamp.pluginId, stamp.pluginRevision,
      stamp.pluginGeneration, fileRef, content.contentId, content.size, content.mediaType])).digest('hex');
  };
  const lookup = (path: string) => {
    const parts = path.split('/').filter(Boolean), key = parts[2];
    const file = key && (pinned.get(key)?.file ?? entries.get(key));
    if (!file || parts.length !== 3 || parts[1] !== key!.slice(0, 2)) throw new LibraryError('not_found', 'Cached file is not active');
    return { ...file, path, name: key!, modifiedAt: fixedTime };
  };
  const internalView: FileView = {
    async stat(entry, signal) {
      const path = typeof entry === 'string' ? entry : entry.path;
      if (!path.startsWith('/__reads')) return input.view.stat(entry, signal);
      if (path === '/__reads' || /^\/__reads\/[a-f0-9]{2}$/.test(path)) return directory(path);
      return lookup(path);
    },
    async list(path, signal) {
      if (!path.startsWith('/__reads')) return input.view.list(path, signal);
      if (path === '/__reads') return bucketNames.map(name => ({ kind: 'directory', path: `${path}/${name}`, name, modifiedAt: fixedTime }));
      const bucket = path.split('/')[2];
      const keys = new Set([...entries.keys(), ...pinned.keys()]);
      return [...keys].filter(key => key.startsWith(bucket ?? '!')).map(name => ({ kind: 'file', path: `${path}/${name}`, name, modifiedAt: fixedTime }));
    },
    async statMany(items, signal) {
      const ordinary = items.filter(item => !item.path.startsWith('/__reads'));
      const result = new Map(ordinary.length ? await input.view.statMany(ordinary, signal) : []);
      for (const item of items) if (item.path.startsWith('/__reads')) {
        try { result.set(item, await internalView.stat(item, signal)); }
        catch (error) { signal.throwIfAborted(); result.set(item, error instanceof Error ? error : new Error('Cached file unavailable')); }
      }
      return result;
    },
    async open(file, range, signal) {
      try {
        const resourceKey = keyFor(file);
        logger.debug('Cache requested source bytes', { resourceKey });
        return await withContext({ resourceKey }, () => input.view.open(file, range, signal));
      }
      catch (error) { if (error instanceof LibraryError) failures.set(keyFor(file), error); throw error; }
    }
  };
  const gateway = createDav(internalView, credentials);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: gateway.fetch });
  const stop = async () => {
    if (starting) await starting;
    if (running) { await input.control.call('serve/stop', { id: running.id }); running = undefined; }
    if (remoteCreated) { await input.control.removeRemote(remote); remoteCreated = false; }
  };
  const ensure = async () => {
    if (closed) throw new LibraryError('source_failed', 'Read cache is closed');
    if (running) return;
    if (starting) return starting;
    starting = (async () => {
      // A backend crash can leave its RC child and cached serve alive. Stop only
      // this module's old remote before replacing its now-dead loopback origin.
      const previous = await input.control.call<{ list: { id: string; params: { fs?: string } }[] }>('serve/list');
      for (const item of previous.list) if (item.params.fs === `${remote}:`) await input.control.call('serve/stop', { id: item.id });
      await input.control.call('config/create', { name: remote, type: 'webdav', parameters: {
        url: new URL('/dav/__reads/', server.url).href, vendor: 'rclone', user: credentials.username, pass: credentials.password },
        opt: { obscure: true, nonInteractive: true } });
      remoteCreated = true;
      const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null) });
      const port = reservation.port; await reservation.stop(true);
      const started = await input.control.call<{ id: string; addr: string }>('serve/start', { type: 'webdav', fs: `${remote}:`, addr: `127.0.0.1:${port}`,
        _config: { BufferSize: 128 * 1024, LowLevelRetries: 1 }, vfsOpt: { ReadOnly: true, CacheMode: 'full',
          CacheMaxSize: settings.maxMiB * 1024 * 1024, CacheMaxAge: settings.maxAgeHours === 0 ? 'off' : `${settings.maxAgeHours}h`,
          ReadAhead: 0, HandleCaching: '0s', ChunkSize: 1024 * 1024, ChunkSizeLimit: -1, ChunkStreams: 0, DirCacheTime: `${CACHE_YEAR_HOURS}h` } });
      running = { id: started.id, address: `http://${started.addr}` };
    })();
    try { await starting; } finally { starting = undefined; }
  };
  const inspect = async (): Promise<ReadCacheStatus> => {
    const result: ReadCacheStatus = { settings: { ...settings }, actualMode: settings.maxMiB === 0 ? 'off' : null,
      state: 'inactive', directory: cacheDirectory, bytesUsed: null, files: null, sampledAt: new Date().toISOString(), message: null };
    if (!running) return result;
    try {
      const stats = statsSchema.parse(await input.control.call('vfs/stats', { fs: `${remote}:` }));
      result.state = 'active'; result.actualMode = stats.opt.CacheMode === 3 || stats.opt.CacheMode === 'full' ? 'full' : 'off';
      if (stats.diskCache) { result.directory = stats.diskCache.path; result.bytesUsed = stats.diskCache.bytesUsed; result.files = stats.diskCache.files; }
    } catch { result.state = 'unavailable'; result.message = t("原生缓存状态暂不可用，请稍后查询。"); }
    return result;
  };
  const assertIdle = () => { if (active) throw new MountError('mount_busy', t("仍有 WebDAV 音频正在读取，请停止播放或扫描后重试。")); };
  const files: FileView = { ...input.view, async open(file, range, signal): Promise<ReadResult> {
    if (!accepting) throw new LibraryError('source_failed', 'Desktop is stopping');
    const key = settings.maxMiB === 0 ? undefined : keyFor(file);
    logger.debug('Audio read selected', { cache: key === undefined ? 'bypass' : 'native', ...(key ? { resourceKey: key } : {}) });
    active++;
    if (key !== undefined) {
      const old = pinned.get(key);
      pinned.set(key, { file, readers: (old?.readers ?? 0) + 1 });
    }
    let released = false; let onAbort: (() => void) | undefined;
    const release = () => {
      if (released) return; released = true; active--;
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (key !== undefined) {
        const item = pinned.get(key)!; if (--item.readers === 0) pinned.delete(key);
      }
    };
    try {
      const expectedLength = range ? range.end - range.start + 1 : file.handle.content.size;
      let result: ReadResult;
      if (key === undefined) result = await input.view.open(file, range, signal);
      else {
        await assertCurrent(file, signal);
        await management;
        const known = entries.has(key); entries.set(key, file);
        await ensure();
        // A new immutable key only changes its bucket listing, not existing file nodes.
        if (!known) await input.control.call('vfs/forget', { fs: `${remote}:`, file: `${key.slice(0, 2)}/${key}` });
        failures.delete(key);
        const response = await cacheFetch(`${running!.address}/${key.slice(0, 2)}/${key}`, { signal,
          headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {} });
        if (response.status !== (range ? 206 : 200) || response.headers.get('content-length') !== String(expectedLength)
          || range && response.headers.get('content-range') !== `bytes ${range.start}-${range.end}/${file.handle.content.size}`) {
          await response.body?.cancel(); const failure = failures.get(key); failures.delete(key);
          throw failure ?? new LibraryError('source_failed', 'Cached audio returned an unexpected response');
        }
        try { await assertCurrent(file, signal); } catch (error) { await response.body?.cancel(); throw error; }
        result = { content: file.handle.content, servedRange: range ?? null, body: response.body! };
      }
      const reader = result.body.getReader(); let received = 0;
      onAbort = () => { void reader.cancel(signal.reason).catch(() => {}).finally(release); };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            signal.throwIfAborted(); const next = await reader.read();
            if (next.done) { reader.releaseLock(); release();
              if (received !== expectedLength) throw new LibraryError('invalid_source', 'Audio ended early');
              controller.close(); return; }
            received += next.value.length;
            if (received > expectedLength) throw new LibraryError('invalid_source', 'Audio exceeded its declared length');
            controller.enqueue(next.value);
          } catch (error) { await reader.cancel(error).catch(() => {}); release(); controller.error(error); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } }
      }, { highWaterMark: 0 });
      return { ...result, body };
    } catch (error) { release(); throw error; }
  } };
  return {
    files, prepareQuit: () => { assertIdle(); accepting = false; return () => { if (!closed) accepting = true; }; }, mountConnection: { url: new URL('/dav/', server.url).href, ...credentials },
    inspect: () => serialize(inspect),
    configure: value => serialize(async () => {
      const next = settingsSchema.parse(value); assertIdle(); await stop();
      await persistSettings(next); settings = next; return inspect();
    }),
    clear: () => serialize(async () => {
      assertIdle(); await stop();
      for (const kind of ['vfs', 'vfsMeta']) await rm(join(input.controlDirectory, 'cache', kind, remote), { recursive: true, force: true });
      return inspect();
    }),
    close: () => serialize(async () => { assertIdle(); await stop(); closed = true; await server.stop(true); })
  };
}
