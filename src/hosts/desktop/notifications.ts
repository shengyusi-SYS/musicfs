import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/** Startup errors must remain visible when the platform launcher has no console. */
export async function reportDesktopStartupFailure(input: { message: string; directory: string; showDialog?: boolean }): Promise<void> {
  const message = input.message.replaceAll('\0', '').slice(0, 4096);
  const logPath = join(input.directory, 'startup.log');
  let logged = false;
  try {
    await mkdir(input.directory, { recursive: true, mode: 0o700 });
    await appendFile(logPath, `${new Date().toISOString()} MusicFS startup: ${message}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(logPath, 0o600);
    logged = true;
  } catch { /* The error still reaches the user when a data directory cannot be written. */ }
  const detail = `MusicFS 启动失败\n\n${message}\n\n${logged ? `诊断日志：${logPath}` : `诊断日志未能写入。请检查数据目录：${input.directory}`}`;
  console.error(detail);
  if (input.showDialog === false) return;

  const run = async (command: string, args: string[], environment: NodeJS.ProcessEnv = process.env): Promise<boolean> => {
    try {
      const child = spawn(command, args, { env: environment, windowsHide: true, stdio: 'ignore' });
      return await new Promise<boolean>(accept => { child.once('error', () => accept(false)); child.once('close', code => accept(code === 0)); });
    } catch { return false; }
  };
  // Script bodies are constants. Dynamic messages are data in env/argv, never executable source.
  if (process.platform === 'win32') {
    const powershell = Bun.which('powershell.exe');
    if (powershell) await run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      '$shell = New-Object -ComObject WScript.Shell; $null = $shell.Popup($env:MUSICFS_STARTUP_ERROR, 0, "MusicFS", 16);'],
    { ...process.env, MUSICFS_STARTUP_ERROR: detail });
    return;
  }
  if (process.platform === 'darwin') {
    const osascript = Bun.which('osascript');
    if (osascript) await run(osascript, ['-e', 'display alert "MusicFS" message (system attribute "MUSICFS_STARTUP_ERROR") as critical'],
      { ...process.env, MUSICFS_STARTUP_ERROR: detail });
    return;
  }
  if (process.platform === 'linux') {
    const zenity = Bun.which('zenity');
    if (zenity && await run(zenity, ['--error', '--no-markup', '--title', 'MusicFS', '--text', detail])) return;
    const kdialog = Bun.which('kdialog');
    if (kdialog) await run(kdialog, ['--title', 'MusicFS', '--error', detail]);
  }
}
