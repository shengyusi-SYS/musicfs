import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generate } from 'selfsigned';
import { z } from 'zod';
import type { DesktopHttps, DesktopHttpsView } from '../../contracts/desktop-https';
import { writePrivateJson } from './rclone-control';

export class DesktopHttpsError extends Error {
  override readonly name = 'DesktopHttpsError';
  constructor(public readonly code: 'https_failed' | 'trust_failed' | 'unsupported_platform', message: string) { super(message); }
}

const stateSchema = z.object({ enabled: z.boolean(), port: z.number().int().min(0).max(65535) });
const trustSchema = z.object({ currentUser: z.boolean(), localMachine: z.boolean() });
const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const encoded = (script: string) => Buffer.from(script, 'utf16le').toString('base64');
const hashScript = `function Get-Sha256($certificate) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($certificate.RawData)).Replace('-', '') }
  finally { $sha.Dispose() }
}`;
const preamble = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false);";

async function powershell(script: string): Promise<string> {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
  const exitCode = await new Promise<number>((accept, reject) => {
    child.once('error', reject); child.once('close', code => accept(code ?? -1));
  });
  if (exitCode !== 0) throw new DesktopHttpsError('trust_failed', 'Windows 证书操作未完成，请重试并确认系统提示。');
  return stdout.trim().replace(/^\uFEFF/, '');
}

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
  let pending = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const result = pending.then(action); pending = result.then(() => {}, () => {}); return result;
  };
  try { state = stateSchema.parse(JSON.parse(await readFile(statePath, 'utf8'))); }
  catch (cause) {
    if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) error = '本机 HTTPS 配置无法读取，请检查数据目录。';
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
    let trust = { currentUser: false, localMachine: false };
    if (platform === 'win32' && certificate) {
      try {
        trust = trustSchema.parse(JSON.parse(await powershell(`${preamble}\n${hashScript}
$expected = ${psLiteral(certificate.fingerprint256.replaceAll(':', ''))}
function Test-Root($location) {
  $store = New-Object Security.Cryptography.X509Certificates.X509Store('Root', $location)
  try {
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    foreach ($candidate in $store.Certificates) { if ((Get-Sha256 $candidate) -eq $expected) { return $true } }
    return $false
  } finally { $store.Close() }
}
@{ currentUser = (Test-Root 'CurrentUser'); localMachine = (Test-Root 'LocalMachine') } | ConvertTo-Json -Compress
`)));
      } catch { error = '无法读取 Windows 证书信任状态，请检查 Windows PowerShell 后重新检测。'; }
    }
    return { platform, enabled: state.enabled, davUrl: server ? `https://127.0.0.1:${state.port}/dav/` : null,
      certificate: certificate ? { fingerprintSha256: certificate.fingerprint256, expiresAt: new Date(certificate.validTo).toISOString() } : null,
      trust, error };
  }
  try {
    await readCertificate();
    if (state.enabled) { await start(); await writePrivateJson(statePath, state); }
  } catch { error = '本机 HTTPS 未能恢复；主程序仍可使用，请检查端口或证书后重新启用。'; }

  return {
    inspect: () => serialize(inspect),
    enable: () => serialize(async () => {
      try {
        await start(); state.enabled = true; await writePrivateJson(statePath, state); error = null;
        return inspect();
      } catch { throw new DesktopHttpsError('https_failed', '无法启用本机 HTTPS，请检查本机端口与数据目录后重试。'); }
    }),
    trust: (scope = 'current-user') => serialize(async () => {
      if (platform !== 'win32') throw new DesktopHttpsError('unsupported_platform', '自动信任证书仅用于 Windows。');
      if (!certificate) throw new DesktopHttpsError('trust_failed', '请先启用本机 HTTPS，再信任本 App 的证书。');
      const location = scope === 'local-machine' ? 'LocalMachine' : 'CurrentUser';
      const installation = `${preamble}\n${hashScript}
$certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2(${psLiteral(certificatePath)})
if ((Get-Sha256 $certificate) -ne ${psLiteral(certificate.fingerprint256.replaceAll(':', ''))}) { throw 'Certificate changed' }
$store = New-Object Security.Cryptography.X509Certificates.X509Store('Root', '${location}')
try { $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite); $store.Add($certificate) }
finally { $store.Close(); $certificate.Dispose() }
`;
      try {
        if (scope === 'local-machine') {
          await powershell(`${preamble}
$child = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -Verb RunAs -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', '${encoded(installation)}') -Wait -PassThru
if ($child.ExitCode -ne 0) { throw 'Certificate installation failed' }
`);
        } else await powershell(installation);
        error = null;
        const view = await inspect();
        if (!(scope === 'local-machine' ? view.trust.localMachine : view.trust.currentUser)) throw new Error('Certificate trust was not installed');
        return view;
      } catch { throw new DesktopHttpsError('trust_failed', '证书信任未完成；请确认 Windows 提示后重试。'); }
    }),
    disable: () => serialize(async () => {
      if (server) { await server.stop(true); server = undefined; }
      state.enabled = false; await writePrivateJson(statePath, state); error = null;
      return inspect();
    }),
    close: () => serialize(async () => { if (server) { await server.stop(true); server = undefined; } })
  };
}
