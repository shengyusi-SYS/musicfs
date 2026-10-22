import { access, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { z } from 'zod';
import type { MountCacheSettings, MountCacheStatus, MountInput, MountManager, MountView } from '../../contracts/mounts';
import { createRcloneControl, MountError, writePrivateJson, type RcloneControl } from './rclone-control';
import { CACHE_YEAR_HOURS, MOUNT_FILE_CACHE_MIB, directoryCacheDefault } from '../../contracts/cache-defaults';

export { MountError } from './rclone-control';

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z.object({ kind: z.literal('remote'), url: z.url().max(4096), username: z.string().max(4096), password: z.string().max(4096) }).strict()
]);
const directoryCacheSeconds = z.number().int().min(0).max(2_147_483_647);
const fileCacheMaxMiB = z.number().int().min(0).max(1_048_576);
const fileCacheMaxAgeHours = z.number().int().min(0).max(2_147_483);
const mountName = z.string().trim().min(1).max(120);
const cacheSchema = z.object({ directoryCacheSeconds, fileCacheMaxMiB: fileCacheMaxMiB.optional(), fileCacheMaxAgeHours: fileCacheMaxAgeHours.optional() }).strict();
const inputSchema = z.object({ name: mountName.optional(), mountPoint: z.string().min(1).max(4096),
  autoMount: z.boolean().default(true),
  directoryCacheSeconds: directoryCacheSeconds.optional(), fileCacheMaxMiB: fileCacheMaxMiB.default(MOUNT_FILE_CACHE_MIB),
  fileCacheMaxAgeHours: fileCacheMaxAgeHours.default(CACHE_YEAR_HOURS), source: sourceSchema }).strict();
const viewSchema = z.object({
  id: z.uuid(), name: z.string(), mountPoint: z.string(), source: z.union([z.object({ kind: z.literal('local') }), z.object({ kind: z.literal('remote'), url: z.string() })]),
  autoMount: z.boolean().default(true),
  directoryCacheSeconds: directoryCacheSeconds.optional(),
  fileCacheMaxMiB: fileCacheMaxMiB.default(MOUNT_FILE_CACHE_MIB), fileCacheMaxAgeHours: fileCacheMaxAgeHours.default(CACHE_YEAR_HOURS),
  state: z.enum(['starting', 'mounted', 'unmounting', 'stopped', 'error']), error: z.object({ code: z.string(), message: z.string() }).optional()
});
const recordsSchema = z.array(z.object({ input: inputSchema, view: viewSchema, mayBeMounted: z.boolean().default(false), cacheDefaultsVersion: z.literal(1).optional() }));
const modes = ['off', 'minimal', 'writes', 'full'] as const;
const nativeStatsSchema = z.object({
  opt: z.object({ CacheMode: z.union([z.enum(modes), z.number().int().min(0).max(3)]) }),
  diskCache: z.object({ path: z.string(), bytesUsed: z.number().nonnegative(), files: z.number().int().nonnegative() }).optional()
});
type RecordEntry = { input: MountInput; view: MountView; mayBeMounted: boolean; cacheDefaultsVersion?: 1 };
type MountPoint = { MountPoint: string; Fs: string };
type Connection = { url: string; username: string; password: string };

// rclone 1.75.2 clips Windows volume labels at 32 bytes. Keep a complete UTF-8 prefix.
function windowsVolumeName(name: string): string {
  let bytes = 0;
  return [...name].filter(character => (bytes += Buffer.byteLength(character, 'utf8')) <= 32).join('');
}

/** Desktop-only ownership of mount definitions, credentials and the private rclone process. */
export async function createMountManager(options: {
  directory: string; binary: string; localConnection: () => Connection;
  /** Narrow integration seam for lifecycle tests, never accepted from an HTTP request. */
  control?: RcloneControl;
  /** A desktop composition sharing RC with DAV cache closes it after both consumers. */
  manageControl?: boolean;
  platform?: NodeJS.Platform;
  checkDependencies?: () => Promise<void>;
}): Promise<MountManager> {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const statePath = join(options.directory, 'mounts.json');
  const platform = options.platform ?? process.platform;
  const mountPath = platform === 'win32' ? win32 : posix;
  const control = options.control ?? createRcloneControl(options);
  let records: RecordEntry[] = [];
  try { records = recordsSchema.parse(JSON.parse(await readFile(statePath, 'utf8'))) as RecordEntry[]; }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new MountError('mount_failed', '挂载配置无法读取，请保留数据并检查本机数据目录。'); }
  let pending = Promise.resolve();
  let pendingActions = 0;
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    pendingActions++;
    const result = pending.then(action).finally(() => { pendingActions--; });
    pending = result.then(() => {}, () => {}); return result;
  };
  let upgradedDefaults = false;
  for (const record of records) {
    if (record.cacheDefaultsVersion === undefined) {
      upgradedDefaults = true;
      if (record.input.directoryCacheSeconds === 300) delete record.input.directoryCacheSeconds;
      if (record.input.fileCacheMaxAgeHours === 168) record.input.fileCacheMaxAgeHours = CACHE_YEAR_HOURS;
      record.cacheDefaultsVersion = 1;
    }
    record.input = normalizeInput(record.input);
    record.view.directoryCacheSeconds = record.input.directoryCacheSeconds!;
    record.view.fileCacheMaxAgeHours = record.input.fileCacheMaxAgeHours!;
  }
  let savedRecords = upgradedDefaults ? '' : JSON.stringify(records);
  const persist = async () => {
    const next = JSON.stringify(records);
    if (next === savedRecords) return;
    await writePrivateJson(statePath, records);
    savedRecords = next;
  };
  const view = (record: RecordEntry): MountView => structuredClone(record.view);
  const remoteName = (record: RecordEntry) => `musicfs_${record.view.id.replaceAll('-', '')}`;
  const cachePath = (record: RecordEntry, kind: 'vfs' | 'vfsMeta') => join(options.directory, 'cache', kind, remoteName(record));
  const removeReadCache = async (record: RecordEntry) => {
    for (const kind of ['vfs', 'vfsMeta'] as const) await rm(cachePath(record, kind), { recursive: true, force: true });
  };
  const equalPoint = (a: string, b: string) => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const activePoints = async () => (await control.call<{ mountPoints: MountPoint[] }>('mount/listmounts')).mountPoints;
  function normalizeInput(value: MountInput): MountInput {
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) throw new MountError('invalid_mount', '请填写有效的挂载位置与读取连接。');
    const input: MountInput = { mountPoint: parsed.data.mountPoint, source: parsed.data.source, directoryCacheSeconds: parsed.data.directoryCacheSeconds ?? directoryCacheDefault(parsed.data.source.kind),
      autoMount: parsed.data.autoMount,
      fileCacheMaxMiB: parsed.data.fileCacheMaxMiB, fileCacheMaxAgeHours: parsed.data.fileCacheMaxAgeHours,
      ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }) };
    if (/[\u0000\r\n]/.test(input.mountPoint) || input.mountPoint.startsWith('-')) throw new MountError('invalid_mount', '挂载路径包含无效字符。');
    const driveLetter = platform === 'win32' && /^[a-z]:$/i.test(input.mountPoint);
    if (!(platform === 'win32' && (driveLetter || input.mountPoint === '*')) && !mountPath.isAbsolute(input.mountPoint)) {
      throw new MountError('invalid_mount', '请选择绝对挂载路径，Windows 也可填写空闲盘符（例如 M:）。');
    }
    // Preserve rclone's bare drive target; win32.normalize('M:') produces 'M:.'
    if (!driveLetter) input.mountPoint = mountPath.normalize(input.mountPoint);
    if (input.source.kind === 'remote') {
      const url = new URL(input.source.url);
      if (!['http:', 'https:'].includes(url.protocol)
        || url.username || url.password || url.search || url.hash) throw new MountError('invalid_mount', '请填写有效的 HTTP(S) WebDAV 地址，并在独立字段填写凭据。');
      input.source.url = url.href;
    }
    return input;
  }
  async function dependencies() {
    if (options.checkDependencies) return options.checkDependencies();
    if (platform === 'linux') {
      try { await access('/dev/fuse'); } catch { throw new MountError('dependency_missing', '未找到 /dev/fuse，请在支持 FUSE 的 Linux 宿主安装并启用 FUSE 后重试。'); }
      if (!Bun.which('fusermount3') && !Bun.which('fusermount')) throw new MountError('dependency_missing', '缺少 fusermount3/fusermount，请安装系统 FUSE 用户工具。');
    }
  }
  async function preparePoint(point: string) {
    if (platform === 'win32' && (point === '*' || /^[a-z]:$/i.test(point))) return;
    // Windows directory mounts require a nonexistent child under an existing parent.
    if (platform === 'win32') {
      try { await lstat(point); throw new MountError('mount_busy', 'Windows 目录挂载需要选择尚不存在的子目录。'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      return;
    }
    await mkdir(point, { recursive: true });
    const info = await lstat(point);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(point)).length) throw new MountError('mount_busy', '挂载位置必须是空目录，不能是符号链接或已占用路径。');
  }
  async function reconcile() {
    if (!records.some(record => record.mayBeMounted)) return;
    try {
      const points = await activePoints();
      for (const record of records) {
        const mounted = points.find(point => equalPoint(point.MountPoint, record.view.mountPoint) && point.Fs === `${remoteName(record)}:`);
        if (!record.mayBeMounted) continue;
        if (mounted && record.input.source.kind === 'local') {
          try {
            // A surviving rclone mount retains its original DAV endpoint across a backend crash.
            const configured = await control.call<{ url?: unknown }>('config/get', { name: remoteName(record) });
            if (typeof configured.url !== 'string' || new URL(configured.url).href !== new URL(options.localConnection().url).href) {
              record.view.state = 'error';
              record.view.error = { code: 'remount_required', message: '本机后台地址已变化，此挂载仍连接旧地址。请点击重新挂载。' };
              continue;
            }
          } catch (error) { record.view.state = 'error'; record.view.error = errorView(error); continue; }
        }
        if (mounted && record.view.state !== 'error') { record.view.state = 'mounted'; delete record.view.error; }
        else if (!mounted) { record.mayBeMounted = false; if (record.view.state !== 'error') record.view.state = 'stopped'; }
      }
    } catch (error) {
      for (const record of records) if (['starting', 'mounted', 'unmounting'].includes(record.view.state)) {
        record.view.state = 'error'; record.view.error = errorView(error);
      }
    }
    await persist();
  }
  async function normalUnmount(record: RecordEntry) {
    const point = record.view.mountPoint;
    if (platform === 'darwin') {
      // rclone 1.75.2 nfsmount's RC unmount uses force. Use the normal system operation instead.
      const command = Bun.which('umount');
      if (!command) throw new MountError('dependency_missing', '缺少系统 umount，无法正常卸载 NFS。');
      const child = Bun.spawn([command, point], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      if (await child.exited !== 0) throw new MountError('mount_busy', '正常卸载失败，请关闭正在使用该目录的程序后重试。');
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (!(await activePoints()).some(item => equalPoint(item.MountPoint, point))) return;
        await Bun.sleep(100);
      }
      throw new MountError('mount_busy', '系统已接受卸载，仍在等待 rclone 确认；请稍后刷新状态。');
    }
    await control.call('mount/unmount', { mountPoint: point });
    if ((await activePoints()).some(item => equalPoint(item.MountPoint, point))) throw new MountError('mount_busy', '挂载尚未退出，请关闭占用程序后重试。');
  }
  async function stop(record: RecordEntry) {
    if (record.mayBeMounted) {
      const current = (await activePoints()).find(item => equalPoint(item.MountPoint, record.view.mountPoint));
      if (current && current.Fs !== `${remoteName(record)}:`) throw new MountError('mount_busy', '此路径的实际挂载身份已变化，未执行卸载；请核对系统挂载状态。');
      if (current) {
        record.view.state = 'unmounting'; delete record.view.error; await persist();
        try { await normalUnmount(record); }
        catch (error) { record.view.state = 'error'; record.view.error = errorView(error); await persist(); throw error; }
      }
      record.mayBeMounted = false;
    }
    try { await control.removeRemote(remoteName(record)); }
    catch (error) { record.view.state = 'error'; record.view.error = errorView(error); await persist(); throw error; }
    record.view.state = 'stopped'; delete record.view.error;
    await persist(); return view(record);
  }

  async function start(record: RecordEntry, input: MountInput) {
    record.input = input; record.view.state = 'starting'; delete record.view.error;
    record.view.name = input.name ?? 'MusicFS';
    record.view.autoMount = input.autoMount ?? true;
    record.view.directoryCacheSeconds = input.directoryCacheSeconds ?? directoryCacheDefault(input.source.kind);
    record.view.fileCacheMaxMiB = input.fileCacheMaxMiB ?? MOUNT_FILE_CACHE_MIB;
    record.view.fileCacheMaxAgeHours = input.fileCacheMaxAgeHours ?? CACHE_YEAR_HOURS;
    record.view.source = input.source.kind === 'local' ? { kind: 'local' } : { kind: 'remote', url: input.source.url };
    await persist();
    try {
      await dependencies(); await preparePoint(input.mountPoint);
      const connection = input.source.kind === 'local' ? options.localConnection() : input.source;
      await control.call('config/create', { name: remoteName(record), type: 'webdav',
        // This read-only profile uses standard DAV properties and lets VFS fingerprint
        // Last-Modified. v1.75.2's "other" profile ignores time and caches by size alone.
        parameters: { url: connection.url, vendor: 'rclone', user: connection.username, pass: connection.password }, opt: { obscure: true, nonInteractive: true } });
      // Fail before creating a filesystem when the remote cannot be listed.
      await control.call('operations/list', { fs: `${remoteName(record)}:`, remote: '', opt: { maxDepth: 1 } });
      const types = await control.call<{ mountTypes: string[] }>('mount/types');
      const mountType = platform === 'darwin' ? 'nfsmount' : platform === 'win32' ? 'cmount' : 'mount';
      if (!types.mountTypes.includes(mountType)) throw new MountError('dependency_missing', `随包 rclone 不支持 ${mountType}，请使用对应平台的完整发行包。`);
      record.mayBeMounted = true;
      await persist();
      const result = await control.call<{ mountPoint: string }>('mount/mount', { fs: `${remoteName(record)}:`, mountPoint: input.mountPoint, mountType,
        // Explorer/players open files just to inspect tags. The default 16MiB buffer + 128MiB
        // initial range downloads audio even for tiny reads. Scope the buffer to this VFS
        // (including a reused RC process); grow chunks normally during sequential playback.
        _config: { BufferSize: 128 * 1024 },
        mountOpt: { AllowOther: false, AllowNonEmpty: false, VolumeName: platform === 'win32' ? windowsVolumeName(record.view.name) : record.view.name }, vfsOpt: { ReadOnly: true, CacheMode: record.view.fileCacheMaxMiB === 0 ? 'off' : 'full',
          CacheMaxSize: record.view.fileCacheMaxMiB * 1024 * 1024,
          CacheMaxAge: record.view.fileCacheMaxAgeHours === 0 ? 'off' : `${record.view.fileCacheMaxAgeHours}h`, ReadAhead: 0,
          // Persist downloaded-range metadata on close, before an immediate normal remount.
          HandleCaching: '0s',
          ChunkSize: 1024 * 1024, ChunkSizeLimit: -1, ChunkStreams: 0,
          DirCacheTime: record.view.directoryCacheSeconds === 0 ? 'off' : `${record.view.directoryCacheSeconds}s` } });
      record.view.mountPoint = result.mountPoint;
      const mounted = (await activePoints()).some(point => equalPoint(point.MountPoint, result.mountPoint));
      if (!mounted) throw new MountError('mount_failed', 'rclone 未确认挂载就绪。');
      // Confirm the actual filesystem root can be opened, not merely that a process exists.
      const root = platform === 'win32' && /^[a-z]:$/i.test(result.mountPoint) ? `${result.mountPoint}\\` : result.mountPoint;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([readdir(root), new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new MountError('mount_failed', '挂载目录暂不可读，请检查网络与挂载状态。')), 8_000);
        })]);
      } finally { clearTimeout(timeout); }
      record.view.state = 'mounted'; delete record.view.error;
    } catch (error) {
      // A failed readiness check must not report success. Retain the definition and any live residue for retry/unmount.
      record.view.state = 'error'; record.view.error = errorView(error);
    }
    await persist(); return view(record);
  }
  function findRecord(id: string) {
    const record = records.find(item => item.view.id === id);
    if (!record) throw new MountError('not_found', '没有找到此挂载。');
    return record;
  }

  await persist();
  return {
    // Native mount/remote checks can take seconds. UI polling reads the current state
    // during that work instead of joining the mutation queue behind startup restores.
    list: () => pendingActions ? Promise.resolve(records.map(view))
      : serialize(async () => { await reconcile(); return records.map(view); }),
    mount: value => serialize(async () => {
      const input = normalizeInput(value);
      await reconcile();
      const previous = records.find(record => equalPoint(record.view.mountPoint, input.mountPoint) || equalPoint(record.input.mountPoint, input.mountPoint));
      if (previous && previous.view.state === 'mounted') {
        if (JSON.stringify(previous.input.source) === JSON.stringify(input.source)) {
          if (previous.view.directoryCacheSeconds !== input.directoryCacheSeconds || previous.view.fileCacheMaxMiB !== input.fileCacheMaxMiB
            || previous.view.fileCacheMaxAgeHours !== input.fileCacheMaxAgeHours) throw new MountError('mount_busy', '此位置已挂载；请通过缓存设置保存并重新挂载。');
          return view(previous);
        }
        throw new MountError('mount_busy', '此路径已挂载其他连接，请先卸载。');
      }
      if (previous?.mayBeMounted) throw new MountError('mount_busy', '此路径仍有待处理的挂载，请先卸载，再重新挂载。');
      const record: RecordEntry = previous ?? {
        input, mayBeMounted: false, cacheDefaultsVersion: 1, view: { id: crypto.randomUUID(), name: input.name ?? 'MusicFS', mountPoint: input.mountPoint,
          autoMount: input.autoMount ?? true,
          directoryCacheSeconds: input.directoryCacheSeconds ?? directoryCacheDefault(input.source.kind),
          fileCacheMaxMiB: input.fileCacheMaxMiB ?? MOUNT_FILE_CACHE_MIB, fileCacheMaxAgeHours: input.fileCacheMaxAgeHours ?? CACHE_YEAR_HOURS,
          source: input.source.kind === 'local' ? { kind: 'local' } : { kind: 'remote', url: input.source.url }, state: 'starting' }
      };
      if (!previous) records.push(record);
      return start(record, input);
    }),
    remount: id => serialize(async () => {
      const record = findRecord(id);
      await stop(record);
      return start(record, normalizeInput(record.input));
    }),
    unmount: id => serialize(async () => {
      return stop(findRecord(id));
    }),
    remove: id => serialize(async () => {
      const record = findRecord(id);
      await stop(record);
      // rclone namespaces sparse data and metadata by this stable remote name.
      // Unmount keeps them for reuse; removing the definition also releases its cache.
      await removeReadCache(record);
      records.splice(records.indexOf(record), 1);
      await persist();
    }),
    rename: (id, name) => serialize(async () => {
      const parsed = mountName.safeParse(name);
      if (!parsed.success) throw new MountError('invalid_mount', '请填写 1—120 个字符的名称。');
      const record = findRecord(id);
      if (record.view.name === parsed.data) return view(record);
      const input = normalizeInput({ ...record.input, name: parsed.data });
      const wasMounted = record.mayBeMounted;
      if (wasMounted) await stop(record);
      if (wasMounted) return start(record, input);
      record.input = input; record.view.name = parsed.data;
      await persist(); return view(record);
    }),
    configureAutoMount: (id, enabled) => serialize(async () => {
      if (typeof enabled !== 'boolean') throw new MountError('invalid_mount', '请选择是否在启动时自动挂载。');
      const record = findRecord(id);
      record.input.autoMount = enabled; record.view.autoMount = enabled;
      await persist(); return view(record);
    }),
    configureCache: (id: string, settings: MountCacheSettings) => serialize(async () => {
      const parsed = cacheSchema.safeParse(settings);
      if (!parsed.success) throw new MountError('invalid_mount', '请填写有效的目录缓存、文件缓存容量和保留时间。');
      const record = findRecord(id);
      const input = normalizeInput({ ...record.input, directoryCacheSeconds: parsed.data.directoryCacheSeconds,
        ...(parsed.data.fileCacheMaxMiB === undefined ? {} : { fileCacheMaxMiB: parsed.data.fileCacheMaxMiB }),
        ...(parsed.data.fileCacheMaxAgeHours === undefined ? {} : { fileCacheMaxAgeHours: parsed.data.fileCacheMaxAgeHours }) });
      if (record.view.directoryCacheSeconds === input.directoryCacheSeconds && record.view.fileCacheMaxMiB === input.fileCacheMaxMiB
        && record.view.fileCacheMaxAgeHours === input.fileCacheMaxAgeHours) return view(record);
      const wasMounted = record.mayBeMounted;
      // Commit the new settings only after a normal unmount succeeds.
      if (wasMounted) await stop(record);
      if (wasMounted) return start(record, input);
      record.input = input; record.view.directoryCacheSeconds = parsed.data.directoryCacheSeconds;
      record.view.fileCacheMaxMiB = input.fileCacheMaxMiB ?? MOUNT_FILE_CACHE_MIB; record.view.fileCacheMaxAgeHours = input.fileCacheMaxAgeHours ?? CACHE_YEAR_HOURS;
      await persist(); return view(record);
    }),
    cacheStatus: id => serialize(async () => {
      const record = findRecord(id);
      const result: MountCacheStatus = { mountId: id, configuredMode: record.view.fileCacheMaxMiB === 0 ? 'off' : 'full',
        actualMode: null, directory: cachePath(record, 'vfs'), state: 'inactive', bytesUsed: null, files: null,
        sampledAt: new Date().toISOString(), message: null };
      if (!record.mayBeMounted) return result;
      try {
        const owned = (await activePoints()).some(point => equalPoint(point.MountPoint, record.view.mountPoint) && point.Fs === `${remoteName(record)}:`);
        if (!owned) return result;
        const stats = nativeStatsSchema.parse(await control.call('vfs/stats', { fs: `${remoteName(record)}:` }));
        result.state = 'active';
        result.actualMode = typeof stats.opt.CacheMode === 'number' ? modes[stats.opt.CacheMode]! : stats.opt.CacheMode;
        if (stats.diskCache) {
          result.directory = stats.diskCache.path;
          result.bytesUsed = stats.diskCache.bytesUsed; result.files = stats.diskCache.files;
        }
      } catch (error) {
        result.state = 'unavailable'; result.message = errorView(error).message;
      }
      result.sampledAt = new Date().toISOString();
      return result;
    }),
    clearCache: id => serialize(async () => {
      const record = findRecord(id);
      const wasMounted = record.mayBeMounted;
      // Busy files keep both the live mount and all cached fragments intact.
      if (wasMounted) await stop(record);
      await removeReadCache(record);
      if (wasMounted) return start(record, normalizeInput(record.input));
      return view(record);
    }),
    refresh: id => serialize(async () => {
      const record = findRecord(id);
      if (!record.mayBeMounted) throw new MountError('invalid_mount', '请先挂载，再刷新挂载目录。');
      const owned = (await activePoints()).some(point => equalPoint(point.MountPoint, record.view.mountPoint) && point.Fs === `${remoteName(record)}:`);
      if (!owned) throw new MountError('invalid_mount', '此挂载已不在运行，请重新挂载后重试。');
      await control.call('vfs/forget', { fs: `${remoteName(record)}:` });
    }),
    refreshLocal: paths => serialize(async () => {
      if (paths?.length === 0) return;
      const local = records.filter(record => record.mayBeMounted && record.view.state === 'mounted' && record.input.source.kind === 'local');
      if (!local.length) return;
      const points = await activePoints();
      for (const record of local) if (points.some(point => equalPoint(point.MountPoint, record.view.mountPoint) && point.Fs === `${remoteName(record)}:`)) {
        if (paths === undefined || paths.includes('/')) await control.call('vfs/forget', { fs: `${remoteName(record)}:` });
        else for (const path of new Set(paths)) await control.call('vfs/forget', { fs: `${remoteName(record)}:`, dir: path.replace(/^\//, '') });
      }
    }),
    close: () => serialize(async () => {
      for (const record of records) if (record.view.state !== 'stopped') await stop(record);
      if (options.manageControl !== false) await control.close();
    })
  };
}

function errorView(error: unknown): { code: string; message: string } {
  return error instanceof MountError ? { code: error.code, message: error.message }
    : { code: 'mount_failed', message: '挂载操作失败，请检查系统权限、网络与本机 rclone 日志。' };
}
