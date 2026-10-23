import { t } from './locale';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { WINDOWS_WEBDAV_FILE_LIMIT, type WindowsWebDavView } from '../../contracts/desktop-https';
import { writePrivateJson } from './rclone-control';

const defaultFileLimit = 50_000_000;
const configuredLimit = z.number().int().min(0).max(WINDOWS_WEBDAV_FILE_LIMIT).nullable();
const backupSchema = z.object({ original: configuredLimit, applied: z.boolean() }).strict();
const windowsSchema = z.object({ trusted: z.boolean(), webClient: z.enum(['running', 'stopped', 'missing']), configuredLimit });
const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const encoded = (script: string) => Buffer.from(script, 'utf16le').toString('base64');
const preamble = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false);";
const parametersPath = 'SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters';
const hashScript = `function Get-Sha256($certificate) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($certificate.RawData)).Replace('-', '') }
  finally { $sha.Dispose() }
}`;

type PowerShell = (script: string) => Promise<string>;
const powershell: PowerShell = async script => {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
  const code = await new Promise<number>((accept, reject) => {
    child.once('error', reject); child.once('close', value => accept(value ?? -1));
  });
  if (code !== 0) throw new Error(t("Windows 连接设置未完成；请确认系统权限提示，关闭正在使用的原生 WebDAV 文件后重试。"));
  return stdout.trim().replace(/^\uFEFF/, '');
};

/** Owns native Windows DAV configuration; TLS and music sources stay separate. */
export function createWindowsWebDav(input: { directory: string; platform?: NodeJS.Platform; powershell?: PowerShell }) {
  const platform = input.platform ?? process.platform;
  const run = input.powershell ?? powershell;
  const backupPath = join(input.directory, 'windows-webdav-original.json');
  async function backup() {
    try { return backupSchema.parse(JSON.parse(await readFile(backupPath, 'utf8'))); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw new Error(t("原生 WebDAV 原设置记录无法读取，请检查本机数据目录。"));
    }
  }
  async function read(fingerprint = '') {
    return windowsSchema.parse(JSON.parse(await run(`${preamble}\n${hashScript}
$expected = ${psLiteral(fingerprint.replaceAll(':', ''))}
function Test-Root {
  $store = New-Object Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
  try {
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    foreach ($candidate in $store.Certificates) { if ((Get-Sha256 $candidate) -eq $expected) { return $true } }
    return $false
  } finally { $store.Close() }
}
$key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('${parametersPath}')
$limit = $null
if ($null -ne $key) {
  try {
    $raw = $key.GetValue('FileSizeLimitInBytes', $null)
    if ($null -ne $raw) { $limit = [long]$raw -band 0xffffffffL }
  } finally { $key.Close() }
}
$service = Get-Service -Name WebClient -ErrorAction SilentlyContinue
$serviceState = if ($null -eq $service) { 'missing' } elseif ($service.Status -eq 'Running') { 'running' } else { 'stopped' }
@{ trusted = (Test-Root); webClient = $serviceState; configuredLimit = $limit } | ConvertTo-Json -Compress
`)));
  }
  async function inspect(fingerprint?: string): Promise<WindowsWebDavView> {
    if (platform !== 'win32') return { trusted: false, webClient: null, fileSizeLimitBytes: null, originalFileSizeLimitBytes: null, canRestoreFileSizeLimit: false };
    const [current, saved] = await Promise.all([read(fingerprint), backup()]);
    return { trusted: current.trusted, webClient: current.webClient, fileSizeLimitBytes: current.configuredLimit ?? defaultFileLimit,
      originalFileSizeLimitBytes: saved ? saved.original ?? defaultFileLimit : null,
      canRestoreFileSizeLimit: !!saved && (saved.applied || saved.original !== current.configuredLimit) };
  }
  async function elevated(script: string) {
    await run(`${preamble}
$child = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -Verb RunAs -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', '${encoded(preamble + '\n' + script)}') -Wait -PassThru
if ($child.ExitCode -ne 0) { throw 'Windows connection setup failed' }
`);
  }
  const setLimit = (value: number | null) => `
$key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('${parametersPath}', $true)
if ($null -eq $key) { throw 'WebClient settings are unavailable' }
try {
  ${value === null ? "$key.DeleteValue('FileSizeLimitInBytes', $false)" : `$signed = [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]${value}), 0)
  $key.SetValue('FileSizeLimitInBytes', $signed, [Microsoft.Win32.RegistryValueKind]::DWord)`}
} finally { $key.Close() }
`;

  return {
    inspect,
    async prepare(certificate: { path: string; fingerprint: string }) {
      if (platform !== 'win32') throw new Error(t("自动连接设置仅用于 Windows。"));
      const current = await read(certificate.fingerprint);
      if (current.webClient === 'missing') throw new Error(t("此 Windows 未提供 WebClient 服务；可使用 App 的本机挂载。"));
      let saved = await backup();
      const changeLimit = current.configuredLimit !== WINDOWS_WEBDAV_FILE_LIMIT;
      const applyLimit = changeLimit || saved?.applied === false;
      if (current.trusted && current.webClient === 'running' && !applyLimit) return;
      if (applyLimit) {
        saved ??= { original: current.configuredLimit, applied: false };
        // Keep the original before UAC/registry work. A failed service restart can
        // then be retried without treating a registry write alone as completion.
        saved.applied = false;
        await writePrivateJson(backupPath, saved);
      }
      await elevated(`${hashScript}
${current.trusted ? '' : `$certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2(${psLiteral(certificate.path)})
if ((Get-Sha256 $certificate) -ne ${psLiteral(certificate.fingerprint.replaceAll(':', ''))}) { throw 'Certificate changed' }
$store = New-Object Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
try { $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite); $store.Add($certificate) }
finally { $store.Close(); $certificate.Dispose() }`}
${changeLimit ? setLimit(WINDOWS_WEBDAV_FILE_LIMIT) : ''}
$service = Get-Service -Name WebClient
if ($service.Status -ne 'Running') { Start-Service -Name WebClient }
${applyLimit ? "else { Restart-Service -Name WebClient }" : ''}
`);
      const actual = await read(certificate.fingerprint);
      if (!actual.trusted || actual.webClient !== 'running' || actual.configuredLimit !== WINDOWS_WEBDAV_FILE_LIMIT) {
        throw new Error(t("Windows 连接设置尚未生效，请重试应用设置。"));
      }
      if (saved && applyLimit) await writePrivateJson(backupPath, { ...saved, applied: true });
    },
    async restoreFileSizeLimit() {
      if (platform !== 'win32') throw new Error(t("恢复原生 WebDAV 设置仅用于 Windows。"));
      const saved = await backup();
      if (!saved) return;
      const current = await read();
      if (saved.applied || saved.original !== current.configuredLimit) {
        await elevated(`${setLimit(saved.original)}
$service = Get-Service -Name WebClient
if ($service.Status -eq 'Running') { Restart-Service -Name WebClient }
`);
        if ((await read()).configuredLimit !== saved.original) throw new Error(t("原文件上限尚未恢复，请重试。"));
      }
      await rm(backupPath, { force: true });
    }
  };
}
