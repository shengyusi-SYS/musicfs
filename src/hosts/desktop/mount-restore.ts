import type { MountManager, MountView } from '../../contracts/mounts';

export type MountRestoreSettings = { enabled: boolean; retry: boolean };

export type MountRestore = {
  /** Begin restoring saved definitions in the background, after DAV is listening. */
  start(): void;
  configure(settings: MountRestoreSettings): void;
  /** A manual action owns this mount for the rest of this desktop session. */
  cancel(id: string): void;
  /** Suspend startup work for a normal quit check; a refused quit can resume it. */
  pause(): Promise<() => void>;
  /** Finish any native operation before the mount manager's normal shutdown. */
  close(): Promise<void>;
};

/** Startup policy only. Credentials, native mounting and persistence remain in MountManager. */
export function createMountRestore(input: {
  mounts: Pick<MountManager, 'list' | 'remount'>;
  settings?: MountRestoreSettings;
  /** Short delays can be supplied by offline lifecycle tests. */
  retryDelaysMs?: readonly number[];
  onError?: (error: unknown) => void;
}): MountRestore {
  let settings = input.settings ?? { enabled: true, retry: true };
  const retryDelays = input.retryDelaysMs ?? [5_000, 15_000];
  const cancelled = new Set<string>();
  let plans: Map<string, { attempts: number; nextAt: number }> | undefined;
  let started = false;
  let closed = false;
  let pauses = 0;
  let running: Promise<void> | undefined;
  let wake = () => {};

  async function wait(milliseconds: number) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(finish, milliseconds);
      timer.unref();
      function finish() { clearTimeout(timer); wake = () => {}; resolve(); }
      wake = finish;
    });
  }

  async function run() {
    if (!plans) {
      const mounts = await input.mounts.list();
      plans = new Map(mounts.filter(mount => mount.autoMount && mount.state !== 'mounted')
        .map(mount => [mount.id, { attempts: 0, nextAt: 0 }]));
    }
    while (!closed && !pauses && settings.enabled && plans.size) {
      for (const id of cancelled) plans.delete(id);
      const next = [...plans].sort((a, b) => a[1].nextAt - b[1].nextAt)[0];
      if (!next) return;
      const [id, plan] = next;
      if (plan.nextAt > Date.now()) { await wait(plan.nextAt - Date.now()); continue; }
      const mount = (await input.mounts.list()).find(item => item.id === id);
      if (closed || pauses || !settings.enabled) return;
      if (cancelled.has(id) || !mount?.autoMount || mount.state === 'mounted') {
        plans.delete(id); continue;
      }
      let result: MountView | undefined;
      let failure: unknown;
      plan.attempts++;
      try { result = await input.mounts.remount(id); }
      catch (error) { failure = error; }
      const code = result?.error?.code ?? (failure instanceof Error && 'code' in failure ? failure.code : undefined);
      const delay = retryDelays[plan.attempts - 1];
      // Dependencies, a busy mount or a full disk need a user action, not network retries.
      if (!closed && settings.retry && code === 'mount_failed' && delay !== undefined && !cancelled.has(id)) {
        plan.nextAt = Date.now() + delay;
      } else {
        plans.delete(id);
        if (failure && code !== 'not_found') input.onError?.(failure);
      }
    }
  }

  function kick() {
    wake();
    if (!started || closed || pauses || !settings.enabled || running) return;
    running = run().catch(error => input.onError?.(error)).finally(() => { running = undefined; });
  }

  return {
    start() { if (started) return; started = true; kick(); },
    configure(next) {
      settings = next;
      if (!next.retry && plans) for (const [id, plan] of plans) if (plan.attempts) plans.delete(id);
      kick();
    },
    cancel(id) { cancelled.add(id); plans?.delete(id); wake(); },
    async pause() {
      pauses++; wake(); await running;
      let resumed = false;
      return () => { if (!resumed) { resumed = true; pauses--; kick(); } };
    },
    async close() { closed = true; wake(); await running; }
  };
}
