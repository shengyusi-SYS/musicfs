import type { Library } from '../../core/library';

/** A desktop process can keep working after its browser closes. Worker scheduling is separate. */
export function createDesktopRefreshRunner(library: Library) {
  const controller = new AbortController();
  let running: Promise<void> | undefined; let requested = false;
  function wake() {
    if (controller.signal.aborted) return;
    requested = true;
    if (running) return;
    running = (async () => {
      do {
        requested = false;
        while (!controller.signal.aborted && await library.refreshes.stepNext(controller.signal)) { /* One persisted page at a time. */ }
      } while (requested && !controller.signal.aborted);
    })().catch(() => {
      if (!controller.signal.aborted) console.error('MusicFS: directory refresh paused; its persisted checkpoint can be retried.');
    }).finally(() => { running = undefined; if (requested) wake(); });
  }
  return { wake, async close() { controller.abort(new Error('Desktop backend is closing')); await running; } };
}
