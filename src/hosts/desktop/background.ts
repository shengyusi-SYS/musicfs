import { setImmediate as yieldToIo } from 'node:timers/promises';

/** One desktop process may drain persisted work after the management page closes. */
export function createDesktopRunner(step: (signal: AbortSignal) => Promise<boolean>, nextAt: () => number | null) {
  const controller = new AbortController();
  let running: Promise<void> | undefined; let requested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function wake() {
    if (controller.signal.aborted) return;
    clearTimeout(timer); timer = undefined;
    requested = true;
    if (running) return;
    running = (async () => {
      do {
        requested = false;
        while (!controller.signal.aborted && await step(controller.signal)) {
          // Hot SQLite/cache steps can otherwise drain entirely as microtasks,
          // delaying playback, management requests and cancellation until the end.
          await yieldToIo(undefined, { signal: controller.signal });
        }
      } while (requested && !controller.signal.aborted);
      const instant = nextAt();
      if (!controller.signal.aborted && instant !== null) {
        timer = setTimeout(wake, Math.max(25, instant - Date.now()));
        timer.unref();
      }
    })().catch(() => {
      if (!controller.signal.aborted) console.error('MusicFS: background work paused; its persisted checkpoint can be retried.');
    }).finally(() => { running = undefined; if (requested) wake(); });
  }
  return { wake, async close() { clearTimeout(timer); controller.abort(new Error('Desktop backend is closing')); await running; } };
}
