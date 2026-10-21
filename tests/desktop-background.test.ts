import { expect, test } from 'bun:test';
import { createDesktopRunner } from '../src/hosts/desktop/background';

test('hot persisted steps let foreground I/O run before the background drain finishes', async () => {
  let steps = 0; let foregroundAt = 0; let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  const runner = createDesktopRunner(async () => { if (++steps < 8) return true; finished(); return false; }, () => null);
  try {
    runner.wake();
    await new Promise<void>(resolve => setImmediate(() => { foregroundAt = steps; resolve(); }));
    await done;
    expect(foregroundAt).toBeGreaterThan(0);
    expect(foregroundAt).toBeLessThan(8);
    expect(steps).toBe(8);
  } finally { await runner.close(); }
});

test('closing during a yielded checkpoint cancels the drain before another source step', async () => {
  let steps = 0; let entered!: () => void; let signal: AbortSignal | undefined;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const runner = createDesktopRunner(async current => { signal = current; steps++; entered(); return true; }, () => null);
  runner.wake(); await ready; await runner.close();
  runner.wake();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(steps).toBe(1);
  expect(signal!.aborted).toBe(true);
});

test('repeated wake requests keep one source step in flight while a slow step yields naturally', async () => {
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let active = 0; let largest = 0; let steps = 0; let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  const runner = createDesktopRunner(async () => {
    active++; largest = Math.max(largest, active);
    if (++steps === 1) await blocked;
    active--;
    if (steps >= 3) { finished(); return false; }
    return true;
  }, () => null);
  try {
    runner.wake(); runner.wake(); runner.wake();
    release(); await done;
    expect(largest).toBe(1); expect(steps).toBeGreaterThanOrEqual(3);
  } finally { await runner.close(); }
});
