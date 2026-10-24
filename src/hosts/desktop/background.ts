import { setImmediate as yieldToIo } from 'node:timers/promises';
import { getLogger } from '@logtape/logtape';
import { errorFields } from '../../infrastructure/logging';

/** One desktop process may drain persisted work after the management page closes. */
export function createDesktopRunner(step: (signal: AbortSignal) => Promise<boolean>, nextAt: () => number | null | Promise<number | null>) {
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
      const instant = await nextAt();
      if (!controller.signal.aborted && instant !== null) {
        timer = setTimeout(wake, Math.min(2_147_483_647, Math.max(25, instant - Date.now())));
        timer.unref();
      }
    })().catch(error => {
      if (!controller.signal.aborted) getLogger(['musicfs', 'background']).error('Background work paused at persisted checkpoint', errorFields(error));
    }).finally(() => { running = undefined; if (requested) wake(); });
  }
  return { wake, async close() { clearTimeout(timer); controller.abort(new Error('Desktop backend is closing')); await running; } };
}
