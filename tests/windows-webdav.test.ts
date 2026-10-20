import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowsWebDav } from '../src/hosts/desktop/windows-webdav';
import { WINDOWS_WEBDAV_FILE_LIMIT } from '../src/contracts/desktop-https';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const certificate = { path: 'C:\\MusicFS\\localhost-cert.pem', fingerprint: 'AB:CD' };
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'musicfs-webdav-limit-')); directories.push(path); return path;
}

for (const original of [null, 128 * 1024 ** 2]) test(`prepare persists and restores the original DWORD ${original ?? 'absence'} across reconstruction`, async () => {
  const path = await directory(); let value: number | null = original; let trusted = false; let applies = 0; let restoring = false;
  const powershell = async (script: string) => {
    if (script.includes('Start-Process')) {
      applies++;
      // The user can close/reopen the App after an OS change; its recovery record
      // must already exist when the elevated action starts.
      expect(JSON.parse(await readFile(join(path, 'windows-webdav-original.json'), 'utf8'))).toEqual({ original, applied: restoring });
      value = restoring ? original : WINDOWS_WEBDAV_FILE_LIMIT; trusted = true;
      return '';
    }
    return JSON.stringify({ trusted, webClient: 'running', configuredLimit: value });
  };
  const first = createWindowsWebDav({ directory: path, platform: 'win32', powershell });
  expect(await first.inspect()).toMatchObject({ fileSizeLimitBytes: original ?? 50_000_000, canRestoreFileSizeLimit: false });
  await first.prepare(certificate);
  expect(await first.inspect()).toMatchObject({ trusted: true, fileSizeLimitBytes: WINDOWS_WEBDAV_FILE_LIMIT,
    originalFileSizeLimitBytes: original ?? 50_000_000, canRestoreFileSizeLimit: true });
  await first.prepare(certificate); expect(applies).toBe(1);
  const reopened = createWindowsWebDav({ directory: path, platform: 'win32', powershell });
  restoring = true; await reopened.restoreFileSizeLimit();
  expect(value).toBe(original); expect(applies).toBe(2);
  expect(await reopened.inspect()).toMatchObject({ fileSizeLimitBytes: original ?? 50_000_000, canRestoreFileSizeLimit: false });
  await reopened.restoreFileSizeLimit(); expect(applies).toBe(2);
});

test('a pre-existing maximum is reused without taking ownership or requesting elevation', async () => {
  const path = await directory(); let calls = 0;
  const settings = createWindowsWebDav({ directory: path, platform: 'win32', powershell: async script => {
    expect(script).not.toContain('Start-Process'); calls++;
    return JSON.stringify({ trusted: true, webClient: 'running', configuredLimit: WINDOWS_WEBDAV_FILE_LIMIT });
  } });
  await settings.prepare(certificate); expect(calls).toBe(1);
  expect(await settings.inspect()).toMatchObject({ fileSizeLimitBytes: WINDOWS_WEBDAV_FILE_LIMIT, canRestoreFileSizeLimit: false });
  expect(await Bun.file(join(path, 'windows-webdav-original.json')).exists()).toBe(false);
});

test('cancelled setup does not claim an OS change; incomplete application can be retried', async () => {
  const path = await directory(); let value: number | null = null; let mode: 'cancel' | 'partial' | 'complete' = 'cancel'; let applies = 0;
  const settings = createWindowsWebDav({ directory: path, platform: 'win32', powershell: async script => {
    if (script.includes('Start-Process')) {
      applies++;
      if (mode === 'cancel') throw new Error('cancelled');
      value = WINDOWS_WEBDAV_FILE_LIMIT;
      if (mode === 'partial') throw new Error('service restart failed');
      return '';
    }
    return JSON.stringify({ trusted: true, webClient: 'running', configuredLimit: value });
  } });
  await expect(settings.prepare(certificate)).rejects.toThrow('cancelled');
  expect(await settings.inspect()).toMatchObject({ fileSizeLimitBytes: 50_000_000, canRestoreFileSizeLimit: false });
  mode = 'partial'; await expect(settings.prepare(certificate)).rejects.toThrow('service restart failed');
  mode = 'complete'; await settings.prepare(certificate); expect(applies).toBe(3);
  expect(await settings.inspect()).toMatchObject({ fileSizeLimitBytes: WINDOWS_WEBDAV_FILE_LIMIT, canRestoreFileSizeLimit: true });
});

test('non-Windows inspection and restore never call a Windows process', async () => {
  const settings = createWindowsWebDav({ directory: await directory(), platform: 'linux', powershell: async () => { throw new Error('No Windows host calls'); } });
  expect(await settings.inspect()).toMatchObject({ fileSizeLimitBytes: null, webClient: null, canRestoreFileSizeLimit: false });
  await expect(settings.prepare(certificate)).rejects.toThrow('仅用于 Windows');
  await expect(settings.restoreFileSizeLimit()).rejects.toThrow('仅用于 Windows');
});
