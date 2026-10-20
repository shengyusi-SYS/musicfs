import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { z } from 'zod';
import type { MountPrerequisites, MountPrerequisitesView } from '../../contracts/mount-prerequisites';
import { MountError } from './rclone-control';

const installerName = 'winfsp-2.1.25156.msi';
const installerSha256 = '073a70e00f77423e34bed98b86e600def93393ba5822204fac57a29324db9f7a';
const preamble = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false);";

// WinFsp owns these registry locations, including its side-by-side driver path.
// A stopped demand-start driver is normal; detection does not start it or rclone.
const inspectScript = `${preamble}
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry32)
$key = $base.OpenSubKey('SOFTWARE\\WinFsp')
$dll = $null
$driver = $false
if ($null -ne $key) {
  foreach ($name in @('SxsDir', 'InstallDir')) {
    $directory = $key.GetValue($name)
    if ($directory) {
      $candidate = Join-Path $directory 'bin\\winfsp-x64.dll'
      if ([IO.File]::Exists($candidate)) { $dll = $candidate; break }
    }
  }
  $key.Close()
}
$base.Close()
$services = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Services')
try {
  foreach ($name in $services.GetSubKeyNames()) {
    if ($name -eq 'WinFsp' -or $name.StartsWith('WinFsp+')) {
      $service = $services.OpenSubKey($name)
      try {
        $image = [string]$service.GetValue('ImagePath')
        $image = [Environment]::ExpandEnvironmentVariables($image).Trim('"')
        if ($image.StartsWith('\\??\\')) { $image = $image.Substring(4) }
        if ([IO.File]::Exists($image)) { $driver = $true; break }
      } finally { $service.Close() }
    }
  }
} finally { $services.Close() }
$version = $null
if ($dll) { $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($dll).ProductVersion }
@{ ready = [bool]($dll -and $driver); version = $version } | ConvertTo-Json -Compress
`;

// The executable/script/options are fixed. The packaged MSI path is environment
// data, and only Windows Installer requests elevation; MusicFS remains unelevated.
const installScript = `${preamble}
if ((Get-FileHash -LiteralPath $env:MUSICFS_WINFSP_MSI -Algorithm SHA256).Hash -ne '${installerSha256}') {
  @{ exitCode = -2 } | ConvertTo-Json -Compress
  exit 0
}
try {
  $arguments = '/i "' + $env:MUSICFS_WINFSP_MSI + '" ADDLOCAL=F.User,F.Main /qb /norestart'
  $installer = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\msiexec.exe') -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  @{ exitCode = $installer.ExitCode } | ConvertTo-Json -Compress
} catch {
  if ($_.Exception.NativeErrorCode -eq 1223) { @{ exitCode = 1223 } | ConvertTo-Json -Compress }
  else { throw }
}
`;

type PowerShell = (script: string, environment?: Record<string, string>) => Promise<{ exitCode: number; stdout: string }>;
const probeSchema = z.object({ ready: z.boolean(), version: z.string().nullable() });
const installationSchema = z.object({ exitCode: z.number().int() });

const runPowerShell: PowerShell = async (script, environment = {}) => {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
  const exitCode = await new Promise<number>((accept, reject) => {
    child.once('error', reject); child.once('close', code => accept(code ?? -1));
  });
  return { exitCode, stdout };
};

/** Windows setup stays outside mount lifecycle and never changes global DAV policy. */
export function createMountPrerequisites(input: {
  resourcesDirectory: string;
  platform?: NodeJS.Platform;
  /** Internal process seam for tests; production uses the Windows PowerShell executable. */
  powershell?: PowerShell;
}): MountPrerequisites {
  const platform = input.platform ?? process.platform;
  const powershell = input.powershell ?? runPowerShell;
  const installerPath = join(input.resourcesDirectory, 'prerequisites', installerName);
  let installing: Promise<MountPrerequisitesView> | undefined;
  let restartRequired = false;

  async function inspect(): Promise<MountPrerequisitesView> {
    if (platform !== 'win32') return { kind: 'none', state: 'not_required', canInstall: false, message: '此平台无需 WinFsp。' };
    const canInstall = await Bun.file(installerPath).exists();
    try {
      const result = await powershell(inspectScript);
      if (result.exitCode !== 0) throw new Error('PowerShell detection failed');
      const probe = probeSchema.parse(JSON.parse(result.stdout.trim().replace(/^\uFEFF/, '')));
      if (restartRequired) return { kind: 'winfsp', state: 'restart_required', canInstall: false,
        message: 'WinFsp 安装完成，Windows 要求重启；请重启电脑后再挂载。', ...(probe.version ? { version: probe.version } : {}) };
      if (probe.ready) return { kind: 'winfsp', state: 'ready', canInstall: false, message: 'WinFsp 已就绪，可直接挂载。',
        ...(probe.version ? { version: probe.version } : {}) };
      return { kind: 'winfsp', state: 'missing', canInstall,
        message: canInstall ? '本机挂载需要 WinFsp。可在此安装随包官方运行组件，Windows 会请求一次安装权限。'
          : '未检测到可用的 WinFsp，且发行包缺少安装器；请重新解压完整 Windows 发行包。' };
    } catch {
      return { kind: 'winfsp', state: 'error', canInstall,
        message: '无法检测 WinFsp；请检查 Windows PowerShell 是否可用，再重新检测。' };
    }
  }

  async function install(): Promise<MountPrerequisitesView> {
    if (platform !== 'win32') throw new MountError('dependency_missing', 'WinFsp 安装仅用于 Windows。');
    const current = await inspect();
    if (current.state === 'ready' || current.state === 'restart_required') return current;
    if (current.state === 'error') throw new MountError('dependency_missing', current.message);
    if (!current.canInstall) throw new MountError('dependency_missing', current.message);
    let code: number;
    try {
      const result = await powershell(installScript, { MUSICFS_WINFSP_MSI: installerPath });
      if (result.exitCode !== 0) throw new Error('PowerShell installer failed');
      code = installationSchema.parse(JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''))).exitCode;
    } catch { throw new MountError('mount_failed', '无法启动 WinFsp 安装器；请确认桌面可交互后重试。'); }
    if (code === 1602 || code === 1223) throw new MountError('mount_failed', '已取消 WinFsp 安装；可稍后在本页重试。');
    if (code === -2) throw new MountError('mount_failed', 'WinFsp 安装包校验失败；请重新解压完整 Windows 发行包。');
    if (code !== 0 && code !== 3010) throw new MountError('mount_failed', `WinFsp 安装未完成（退出码 ${code}）；请关闭安装窗口后重试。`);
    restartRequired = code === 3010;
    const result = await inspect();
    if (result.state !== 'ready' && result.state !== 'restart_required') {
      throw new MountError('dependency_missing', 'WinFsp 安装器已结束，但运行组件尚未就绪；请重新检测或检查 Windows 安装结果。');
    }
    return result;
  }

  return {
    inspect,
    installWinFsp() {
      if (!installing) installing = install().finally(() => { installing = undefined; });
      return installing;
    },
    async check() {
      if (platform !== 'win32') return;
      const result = await inspect();
      if (result.state !== 'ready') throw new MountError('dependency_missing', result.message);
    }
  };
}
