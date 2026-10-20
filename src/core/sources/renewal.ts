import type { Context, Outcome, PluginFault, SourcePlugin } from '@musicfs/plugin-api';
import { SourceError, type InstanceSnapshot, type InstanceStore, type SourceStamp } from './types';

export type RenewalClaim = { kind: 'acquired'; snapshot: InstanceSnapshot }
  | { kind: 'busy'; until: number } | { kind: 'failed'; error: PluginFault } | { kind: 'retry' };
type Stored<T> = T | Promise<T>;
/** Claim reserves a state revision; finish accepts state/failure and releases atomically. */
export interface RenewalStore {
  claimRenewal(expected: InstanceSnapshot, token: string, now: number, until: number): Stored<RenewalClaim>;
  finishRenewal(expected: InstanceSnapshot, token: string, outcome: Outcome<null>, now: number, retryAt: number): Stored<boolean>;
  releaseRenewal(instanceId: string, token: string): Stored<void>;
}
const sameSource = (a: SourceStamp, b: SourceStamp) => a.id === b.id && a.pluginId === b.pluginId && a.epoch === b.epoch
  && a.pluginRevision === b.pluginRevision && a.pluginGeneration === b.pluginGeneration;
const stale = () => new SourceError('stale_call', 'The source changed while preparing its session');
function pause(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** The lease covers renewal only. Ordinary source calls and audio streams remain concurrent. */
export async function prepareSession(input: { initial: InstanceSnapshot; plugin: SourcePlugin; store: InstanceStore & RenewalStore;
  context(snapshot: InstanceSnapshot, signal: AbortSignal): Context; now(): number }, signal: AbortSignal): Promise<Outcome<InstanceSnapshot>> {
  const renewal = input.plugin.renewal;
  if (!renewal) return { ok: true, value: input.initial };
  let snapshot = input.initial; let delay = 50;
  const deadline = input.now() + 25_000;
  const needed = async () => {
    try {
      const result = await renewal.needed(input.context(snapshot, signal)); signal.throwIfAborted();
      if (typeof result !== 'boolean') throw new Error('Invalid session policy');
      return result;
    } catch { signal.throwIfAborted(); throw new SourceError('plugin_failure', 'Source session policy failed unexpectedly'); }
  };
  const recapture = async () => {
    const latest = await input.store.capture(snapshot.id);
    if (!latest || !sameSource(input.initial, latest)) throw stale();
    snapshot = latest;
  };
  let requiresRenewal = await needed();
  while (requiresRenewal) {
    signal.throwIfAborted();
    const token = crypto.randomUUID(); const now = input.now();
    if (now >= deadline) return { ok: false, error: { kind: 'temporary', message: '来源授权正在续期，请稍后重试。', retryAfterSeconds: 1 } };
    const claimed = await input.store.claimRenewal(snapshot, token, now, now + 60_000);
    if (claimed.kind === 'failed') return { ok: false, error: claimed.error };
    if (claimed.kind === 'retry') { await recapture(); requiresRenewal = await needed(); continue; }
    if (claimed.kind === 'busy') {
      await pause(Math.min(delay, Math.max(25, claimed.until - now)), signal); delay = Math.min(1000, delay * 2);
      continue;
    }
    snapshot = claimed.snapshot;
    try {
      if (!sameSource(input.initial, snapshot)) throw stale();
      if (!await needed()) break;
      const renewalSignal = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
      let outcome: Outcome<null>;
      try { outcome = await renewal.renew(input.context(snapshot, renewalSignal)); }
      catch { signal.throwIfAborted(); outcome = { ok: false, error: { kind: 'temporary', message: '来源授权暂未完成续期，请稍后重试。', retryAfterSeconds: 1 } }; }
      signal.throwIfAborted();
      const completedAt = input.now();
      const retryAt = outcome.ok ? 0 : completedAt + Math.max(1000, (outcome.error.retryAfterSeconds ?? 1) * 1000);
      if (!await input.store.finishRenewal(snapshot, token, outcome, completedAt, retryAt)) throw stale();
      if (!outcome.ok) return { ok: false, error: outcome.error };
      await recapture();
      return { ok: true, value: snapshot };
    } finally { await input.store.releaseRenewal(snapshot.id, token); }
  }
  return { ok: true, value: snapshot };
}
