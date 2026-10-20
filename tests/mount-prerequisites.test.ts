import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMountPrerequisites } from '../src/hosts/desktop/mount-prerequisites';

const cleanup: string[] = [];
afterEach(async () => { for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function resources(installer = true) {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-prerequisites-')); cleanup.push(directory);
  if (installer) {
    await mkdir(join(directory, 'prerequisites'));
    // The process seam never invokes Windows Installer. Production verifies the
    // official checksum in the fixed PowerShell script before requesting UAC.
    await writeFile(join(directory, 'prerequisites', 'winfsp-2.1.25156.msi'), 'process-seam fixture');
  }
  return directory;
}

test('non-Windows does not invoke PowerShell or request a WinFsp installation', async () => {
  const prerequisite = createMountPrerequisites({ resourcesDirectory: 'unused', platform: 'linux',
    powershell: async () => { throw new Error('Must not touch the Windows host'); } });
  expect(await prerequisite.inspect()).toMatchObject({ kind: 'none', state: 'not_required', canInstall: false });
  await prerequisite.check();
  await expect(prerequisite.installWinFsp()).rejects.toMatchObject({ code: 'dependency_missing' });
});

test('an installed runtime is reused even when the optional installer is absent', async () => {
  let calls = 0;
  const prerequisite = createMountPrerequisites({ resourcesDirectory: await resources(false), platform: 'win32',
    powershell: async script => {
      calls++; expect(script).toContain('Registry32'); expect(script).toContain('winfsp-x64.dll');
      expect(script).toContain('ImagePath'); expect(script).not.toContain('Start-Process');
      return { exitCode: 0, stdout: JSON.stringify({ ready: true, version: '2.1.25156' }) };
    } });
  expect(await prerequisite.installWinFsp()).toMatchObject({ state: 'ready', canInstall: false, version: '2.1.25156' });
  expect(calls).toBe(1); await prerequisite.check();
});

test('missing runtime is actionable before mounting and duplicate install requests share one installer', async () => {
  let ready = false; let installs = 0;
  const directory = await resources();
  const prerequisite = createMountPrerequisites({ resourcesDirectory: directory, platform: 'win32',
    powershell: async (script, environment) => {
      if (!environment) return { exitCode: 0, stdout: JSON.stringify({ ready, version: ready ? '2.1.25156' : null }) };
      installs++;
      expect(environment.MUSICFS_WINFSP_MSI).toBe(join(directory, 'prerequisites', 'winfsp-2.1.25156.msi'));
      expect(script).toContain('Get-FileHash -LiteralPath $env:MUSICFS_WINFSP_MSI');
      expect(script).toContain('073a70e00f77423e34bed98b86e600def93393ba5822204fac57a29324db9f7a');
      expect(script).toContain('ADDLOCAL=F.User,F.Main /qb /norestart'); expect(script).toContain('-Verb RunAs');
      await Bun.sleep(5); ready = true;
      return { exitCode: 0, stdout: '{"exitCode":0}' };
    } });
  expect(await prerequisite.inspect()).toMatchObject({ state: 'missing', canInstall: true });
  await expect(prerequisite.check()).rejects.toMatchObject({ code: 'dependency_missing' });
  const [first, second] = await Promise.all([prerequisite.installWinFsp(), prerequisite.installWinFsp()]);
  expect(first.state).toBe('ready'); expect(second).toEqual(first); expect(installs).toBe(1);
  await prerequisite.check();
});

test('installer cancellation is readable and a reboot request never restarts Windows automatically', async () => {
  let installerCode = 1223;
  const prerequisite = createMountPrerequisites({ resourcesDirectory: await resources(), platform: 'win32',
    powershell: async (_script, environment) => environment
      ? { exitCode: 0, stdout: JSON.stringify({ exitCode: installerCode }) }
      : { exitCode: 0, stdout: '{"ready":false,"version":null}' } });
  await expect(prerequisite.installWinFsp()).rejects.toThrow('已取消');
  installerCode = 1602;
  await expect(prerequisite.installWinFsp()).rejects.toThrow('已取消');
  installerCode = 3010;
  expect(await prerequisite.installWinFsp()).toMatchObject({ state: 'restart_required', canInstall: false });
  await expect(prerequisite.check()).rejects.toThrow('重启');
});

test('incomplete bundles, checksum failures and detection failures stay distinct', async () => {
  const missing = createMountPrerequisites({ resourcesDirectory: await resources(false), platform: 'win32',
    powershell: async () => ({ exitCode: 0, stdout: '{"ready":false,"version":null}' }) });
  expect(await missing.inspect()).toMatchObject({ state: 'missing', canInstall: false });
  await expect(missing.installWinFsp()).rejects.toThrow('发行包缺少安装器');
  const invalid = createMountPrerequisites({ resourcesDirectory: await resources(), platform: 'win32',
    powershell: async (_script, environment) => environment
      ? { exitCode: 0, stdout: '{"exitCode":-2}' }
      : { exitCode: 0, stdout: '{"ready":false,"version":null}' } });
  await expect(invalid.installWinFsp()).rejects.toThrow('校验失败');
  const failed = createMountPrerequisites({ resourcesDirectory: await resources(), platform: 'win32',
    powershell: async () => ({ exitCode: 1, stdout: '' }) });
  expect(await failed.inspect()).toMatchObject({ state: 'error' });
  await expect(failed.check()).rejects.toThrow('PowerShell');
});
