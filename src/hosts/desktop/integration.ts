import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type DesktopTrayAction = 'open' | 'phone' | 'quit';
export interface DesktopIntegration { close(): Promise<void> }

function executable(resourcesDirectory: string) {
  return join(resourcesDirectory, process.platform === 'win32' ? 'desktop-helper.exe' : 'desktop-helper');
}

/** The helper owns OS integration; the existing backend handles every action. */
export function startDesktopIntegration(input: {
  resourcesDirectory: string;
  onAction(action: DesktopTrayAction): void | Promise<void>;
  onError?(error: Error): void;
}): Promise<DesktopIntegration> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable(input.resourcesDirectory), ['tray'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    const lines = createInterface({ input: child.stdout });
    let ready = false; let closing = false; let settled = false; let failed = false; let diagnostic = '';
    let resolveClosed: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const timer = setTimeout(() => fail(new Error('MusicFS tray did not become ready')), 10_000);
    timer.unref();

    function fail(error: Error) {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      if (!settled) { settled = true; reject(error); }
      else if (!closing) input.onError?.(error);
      child.kill();
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { diagnostic = (diagnostic + chunk).slice(-4096); });
    child.on('error', fail);
    // Early native startup failure can close stdin before close() is called.
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => {
      clearTimeout(timer); lines.close(); resolveClosed();
      if (!closing) fail(new Error(diagnostic.trim() || `MusicFS tray stopped (${signal ?? code})`));
    });
    lines.on('line', line => {
      let event: { type?: unknown; action?: unknown };
      try { event = JSON.parse(line) as typeof event; }
      catch { fail(new Error('MusicFS tray returned an invalid event')); return; }
      if (event.type === 'ready' && !ready) {
        ready = true; settled = true; clearTimeout(timer);
        resolve({ async close() {
          if (closing) { await closed; return; }
          closing = true;
          child.stdin.end();
          const stop = setTimeout(() => child.kill(), 1500); stop.unref();
          try { await closed; } finally { clearTimeout(stop); }
        } });
      } else if (event.type === 'action' && ready && !closing
        && (event.action === 'open' || event.action === 'phone' || event.action === 'quit')) {
        Promise.resolve().then(() => input.onAction(event.action as DesktopTrayAction))
          .catch(error => input.onError?.(error instanceof Error ? error : new Error(String(error))));
      }
    });
  });
}

/** A fresh enable call also updates the registered executable after an upgrade. */
export async function setDesktopAutostart(input: {
  resourcesDirectory: string;
  enabled: boolean;
  command: string[];
}): Promise<void> {
  if (!input.command[0]) throw new Error('The startup command must include its executable');
  const child = Bun.spawn([executable(input.resourcesDirectory), 'autostart'], {
    windowsHide: true, stdin: new Blob([JSON.stringify({ enabled: input.enabled, command: input.command })]),
    stdout: 'ignore', stderr: 'pipe'
  });
  const diagnostic = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), 10_000); timer.unref();
  try {
    const code = await child.exited;
    if (code !== 0) throw new Error((await diagnostic).trim() || 'MusicFS could not update login startup');
    await diagnostic;
  } finally { clearTimeout(timer); }
}
