import { t } from './locale';
import { X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generate } from 'selfsigned';
import { z } from 'zod';
import type { DesktopHttps, DesktopHttpsView } from '../../contracts/desktop-https';
import { writePrivateJson } from './rclone-control';
import { createWindowsWebDav } from './windows-webdav';

export class DesktopHttpsError extends Error {
  override readonly name = 'DesktopHttpsError';
  constructor(public readonly code: 'https_failed' | 'trust_failed' | 'unsupported_platform', message: string) { super(message); }
}

const stateSchema = z.object({ enabled: z.boolean(), port: z.number().int().min(0).max(65535) });

/** Optional loopback DAV listener; desktop management stays on its existing endpoint. */
export async function createDesktopHttps(options: {
  directory: string;
  fetch: (request: Request) => Response | Promise<Response>;
  platform?: NodeJS.Platform;
}): Promise<DesktopHttps> {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const platform = options.platform ?? process.platform;
  const statePath = join(options.directory, 'https.json');
  const certificatePath = join(options.directory, 'localhost-cert.pem');
  const keyPath = join(options.directory, 'localhost-key.pem');
  let state = { enabled: false, port: 0 };
  let server: ReturnType<typeof Bun.serve> | undefined;
  let certificate: X509Certificate | undefined;
  let error: string | null = null;
  let windowsError: string | null = null;
  const windows = createWindowsWebDav({ directory: options.directory, platform });
  let pending = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const result = pending.then(action); pending = result.then(() => {}, () => {}); return result;
  };
  try { state = stateSchema.parse(JSON.parse(await readFile(statePath, 'utf8'))); }
  catch (cause) {
    if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) error = t("本机 HTTPS 配置无法读取，请检查数据目录。");
  }

  async function readCertificate() {
    try { certificate = new X509Certificate(await readFile(certificatePath)); }
    catch (cause) { if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause; }
  }
  async function material() {
    await readCertificate();
    if (!certificate) {
      // A leaf certificate limits this trust entry to the local MusicFS endpoint.
      const now = Date.now();
      const pems = await generate([{ name: 'commonName', value: 'MusicFS localhost' }], {
        algorithm: 'sha256', keySize: 2048, notBeforeDate: new Date(now - 5 * 60_000),
        notAfterDate: new Date(now + 3 * 365 * 86_400_000),
        extensions: [
          { name: 'basicConstraints', cA: false, critical: true },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
          { name: 'extKeyUsage', serverAuth: true },
          { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, { type: 7, ip: '::1' }] }
        ]
      });
      await writeFile(keyPath, pems.private, { mode: 0o600 });
      await writeFile(certificatePath, pems.cert, { mode: 0o600 });
      certificate = new X509Certificate(pems.cert);
    }
    return { key: await readFile(keyPath, 'utf8'), cert: await readFile(certificatePath, 'utf8') };
  }
  async function start() {
    if (server) return;
    const tls = await material();
    server = Bun.serve({ hostname: '127.0.0.1', port: state.port, tls, idleTimeout: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path !== '/dav' && !path.startsWith('/dav/')) return new Response('Not found', { status: 404 });
        return options.fetch(request);
      }
    });
    state.port = server.port!;
  }
  async function inspect(): Promise<DesktopHttpsView> {
    let native: Awaited<ReturnType<typeof windows.inspect>> = { trusted: false, webClient: null,
      fileSizeLimitBytes: null, originalFileSizeLimitBytes: null, canRestoreFileSizeLimit: false };
    try { native = await windows.inspect(certificate?.fingerprint256); windowsError = null; }
    catch { windowsError = t("无法读取 Windows 连接设置，请检查 Windows PowerShell 后重新检测。"); }
    return { platform, enabled: state.enabled, davUrl: server ? `https://127.0.0.1:${state.port}/dav/` : null,
      certificate: certificate ? { fingerprintSha256: certificate.fingerprint256, expiresAt: new Date(certificate.validTo).toISOString() } : null,
      ...native, error: error ?? windowsError };
  }
  try {
    await readCertificate();
    if (state.enabled) { await start(); await writePrivateJson(statePath, state); }
  } catch { error = t("本机 HTTPS 未能恢复；主程序仍可使用，请检查端口或证书后重新启用。"); }

  return {
    inspect: () => serialize(inspect),
    enable: () => serialize(async () => {
      try {
        await start(); state.enabled = true; await writePrivateJson(statePath, state); error = null;
        return inspect();
      } catch { throw new DesktopHttpsError('https_failed', t("无法启用本机 HTTPS，请检查本机端口与数据目录后重试。")); }
    }),
    trust: () => serialize(async () => {
      if (platform !== 'win32') throw new DesktopHttpsError('unsupported_platform', t("自动信任证书仅用于 Windows。"));
      if (!state.enabled || !server || !certificate) throw new DesktopHttpsError('trust_failed', t("请先启用本机 HTTPS，再完成 Windows 连接设置。"));
      try {
        await windows.prepare({ path: certificatePath, fingerprint: certificate.fingerprint256 });
        error = null;
        return inspect();
      } catch (cause) { throw new DesktopHttpsError('trust_failed', cause instanceof Error ? cause.message : t("Windows 连接设置未完成，请重试。")); }
    }),
    restoreFileSizeLimit: () => serialize(async () => {
      if (platform !== 'win32') throw new DesktopHttpsError('unsupported_platform', t("恢复原生 WebDAV 设置仅用于 Windows。"));
      try { await windows.restoreFileSizeLimit(); return inspect(); }
      catch (cause) { throw new DesktopHttpsError('trust_failed', cause instanceof Error ? cause.message : t("恢复原文件上限未完成，请重试。")); }
    }),
    disable: () => serialize(async () => {
      if (server) { await server.stop(true); server = undefined; }
      state.enabled = false; await writePrivateJson(statePath, state); error = null;
      return inspect();
    }),
    close: () => serialize(async () => { if (server) { await server.stop(true); server = undefined; } })
  };
}
