import { t } from './locale';
import { getLogger, withContext } from '@logtape/logtape';
import { observeFetch } from '../../infrastructure/io-diagnostics';
import { errorFields } from '../../infrastructure/logging';
import type { NativeLogLevel } from '../../contracts/diagnostics';

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const controlFetch = observeFetch(fetch, 'rclone', process.env);

export class MountError extends Error {
  override readonly name = 'MountError';
  constructor(public readonly code: 'invalid_mount' | 'dependency_missing' | 'disk_full' | 'mount_failed' | 'mount_busy' | 'not_found', message: string,
    public readonly translation?: import('@musicfs/plugin-api').MessageTranslation) {
    super(message);
  }
}

export interface RcloneControl {
  call<T = Record<string, unknown>>(method: string, parameters?: Record<string, unknown>): Promise<T>;
  removeRemote(name: string): Promise<void>;
  close(): Promise<void>;
  configureLogging?(level: NativeLogLevel): Promise<void>;
}

const runtimeSchema = z.object({ pid: z.number().int().positive(), port: z.number().int().min(1).max(65535), password: z.string().min(32) }).strict();
type Runtime = z.infer<typeof runtimeSchema>;
const diskFull = () => new MountError('disk_full', t("磁盘空间不足；请释放 MusicFS 数据目录或挂载缓存所在磁盘的空间后重试。"));

export async function writePrivateJson(path: string, value: unknown) {
  const staging = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(staging, JSON.stringify(value), { mode: 0o600 });
    await rename(staging, path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOSPC') throw diskFull();
    throw error;
  } finally { await rm(staging, { force: true }); }
}

/** One private, authenticated rclone RC process; all filesystem work stays in rclone. */
export function createRcloneControl(input: { directory: string; binary: string; startupTimeoutMs?: number; logLevel?: NativeLogLevel }): RcloneControl {
  let logLevel = input.logLevel ?? 'ERROR';
  let runtime: Runtime | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let starting: Promise<Runtime> | undefined;
  const runtimePath = join(input.directory, 'rclone-runtime.json');
  const configPath = join(input.directory, 'rclone.conf');

  async function request<T>(current: Runtime, method: string, parameters: Record<string, unknown> = {}, timeout = 30_000): Promise<T> {
    // Readiness/recovery probes can fail normally while the native process starts.
    const fetcher = method === 'core/pid' ? fetch : controlFetch;
    const response = await withContext({ ioOperation: method }, () => fetcher(`http://127.0.0.1:${current.port}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${btoa(`musicfs:${current.password}`)}` },
      body: JSON.stringify(parameters), signal: AbortSignal.timeout(timeout)
    }));
    const body: unknown = await response.json();
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(body);
      // Never return rclone's raw message: it can contain remote URLs or credentials.
      if (error.success && /\bENOSPC\b|no space left on device|\bdisk (?:is )?full\b/i.test(error.data.error)) throw diskFull();
      if (error.success && /busy|already mounted|not empty/i.test(error.data.error)) throw new MountError('mount_busy', t("挂载路径正在使用；请关闭占用文件的程序后重试。"));
      if (error.success && /fusermount|libfuse|winfsp|mount type|not registered|cannot find|executable file not found/i.test(error.data.error)) {
        throw new MountError('dependency_missing', t("系统挂载依赖不可用。Linux 请检查 FUSE/fusermount，Windows 请安装 WinFsp；macOS 请检查系统 NFS 挂载权限。"));
      }
      throw new MountError('mount_failed', t("rclone 操作失败，请检查远程地址、读取凭据、网络及本机 rclone 日志。"));
    }
    return body as T;
  }

  async function ensure(): Promise<Runtime> {
    if (runtime) return runtime;
    if (starting) return starting;
    let launched: ReturnType<typeof Bun.spawn> | undefined;
    starting = (async () => {
      await mkdir(input.directory, { recursive: true, mode: 0o700 });
      let saved: Runtime | undefined;
      try {
        saved = runtimeSchema.parse(JSON.parse(await readFile(runtimePath, 'utf8')));
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new MountError('mount_failed', t("rclone 运行记录无法读取，请保留文件并核对实际系统挂载。"));
      }
      if (saved) {
        try {
          const identity = await request<{ pid: number }>(saved, 'core/pid', {}, 1_000);
          if (identity.pid === saved.pid) {
            await request(saved, 'options/set', { main: { LogLevel: logLevel } }, 1_000).catch(error =>
              getLogger(['musicfs', 'io', 'rclone']).warning('Native log level not applied', errorFields(error)));
            return runtime = saved;
          }
        } catch { /* Probe the recorded process without signalling or replacing it. */ }
        let alive = true;
        try { process.kill(saved.pid, 0); }
        catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') alive = false; }
        if (alive) throw new MountError('mount_failed', t("旧挂载进程仍在运行但身份暂不可确认，未创建替代进程；请检查本机挂载与 rclone 日志后重试。"));
      }
      if (!await Bun.file(input.binary).exists()) throw new MountError('dependency_missing', t("发行包缺少 rclone，请重新解压完整发行包。"));
      // The OS chooses the control port. A competing bind causes startup to fail, never reuse an unknown server.
      const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 503 }) });
      const port = reservation.port;
      await reservation.stop(true);
      if (!port) throw new MountError('mount_failed', t("无法为本地挂载控制分配端口。"));
      const password = crypto.randomUUID() + crypto.randomUUID();
      const logPath = join(input.directory, 'rclone.log');
      if (!await Bun.file(configPath).exists()) await writeFile(configPath, '', { mode: 0o600 });
      if (!await Bun.file(logPath).exists()) await writeFile(logPath, '', { mode: 0o600 });
      child = Bun.spawn([input.binary, 'rcd', '--rc-addr', `127.0.0.1:${port}`, '--config', configPath,
        '--cache-dir', join(input.directory, 'cache'), '--log-file', logPath, '--log-level', logLevel,
        '--log-file-max-size', '2M', '--log-file-max-backups', '3', '--use-json-log'], {
        windowsHide: true, env: { ...process.env, RCLONE_RC_USER: 'musicfs', RCLONE_RC_PASS: password }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
      });
      launched = child;
      const current = { pid: child.pid, port, password };
      const deadline = Date.now() + (input.startupTimeoutMs ?? 8_000);
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new MountError('dependency_missing', t("rclone 未能启动，请检查发行包与系统依赖。"));
        let identity: { pid: number } | undefined;
        try { identity = await request<{ pid: number }>(current, 'core/pid', {}, 500); }
        catch { /* rclone may listen before its authenticated RC handlers are ready. */ }
        if (identity) {
          if (identity.pid !== child.pid) { child.kill('SIGTERM'); await child.exited; throw new MountError('mount_failed', t("挂载控制进程身份不匹配。")); }
          await writePrivateJson(runtimePath, current);
          return runtime = current;
        }
        await Bun.sleep(50);
      }
      child.kill('SIGTERM');
      await child.exited;
      throw new MountError('mount_failed', t("等待本地 rclone 启动超时。"));
    })();
    try { return await starting; }
    catch (error) {
      if (!runtime && launched && launched.exitCode === null) { launched.kill('SIGTERM'); await launched.exited; }
      throw error;
    } finally { starting = undefined; }
  }

  async function call<T>(method: string, parameters: Record<string, unknown> = {}): Promise<T> {
    const current = await ensure();
    try { return await request<T>(current, method, parameters); }
    catch (error) {
      if (error instanceof MountError) throw error;
      runtime = undefined;
      throw new MountError('mount_failed', t("与本地 rclone 的连接中断，请查看挂载状态后重试。"));
    }
  }

  return {
    call,
    async configureLogging(next) {
      const previous = logLevel;
      logLevel = next;
      try {
        const current = runtime ?? (starting ? await starting : undefined);
        if (current) await request(current, 'options/set', { main: { LogLevel: next } }, 3_000);
      } catch (error) { logLevel = previous; throw error; }
    },
    async removeRemote(name) {
      // A dependency check can fail before rclone creates any config. Removing that
      // saved mount must not require starting a missing or unused rclone binary.
      if (!await Bun.file(configPath).exists()) return;
      await call('config/delete', { name });
    },
    async close() {
      if (child && child.exitCode !== null) { runtime = undefined; return; }
      if (!runtime) {
        try {
          const saved = runtimeSchema.parse(JSON.parse(await readFile(runtimePath, 'utf8')));
          if ((await request<{ pid: number }>(saved, 'core/pid', {}, 800)).pid === saved.pid) runtime = saved;
        } catch { return; }
      }
      if (!runtime) return;
      const current = runtime;
      // Callers unmount first; do not terminate a process which still owns a filesystem.
      const mounted = await request<{ mountPoints: unknown[] }>(current, 'mount/listmounts');
      if (mounted.mountPoints.length) throw new MountError('mount_busy', t("仍有活动挂载，后台暂不能退出。"));
      await request(current, 'core/quit');
      if (child) await child.exited;
      else {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          try { await request(current, 'core/pid', {}, 300); }
          catch { break; }
          await Bun.sleep(50);
        }
      }
      await rm(runtimePath, { force: true });
      runtime = undefined;
    }
  };
}
