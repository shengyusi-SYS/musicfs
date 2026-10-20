import type { AuthAction, AuthStep, Context, Json, Outcome, Page, Root, Entry, FileInfo, ReadRequest, ReadResult, SourcePlugin } from '@musicfs/plugin-api';
import { z } from 'zod';
import type { PluginRegistry } from '../extensions';

import { SourceError, type Instance, type InstanceSnapshot, type SourceStamp, type Authentication, type AuthenticationRecord, type AuthenticationAction, type InstanceStore } from './types';
import { prepareSession, type RenewalStore } from './renewal';
export { SourceError, type Instance, type InstanceSnapshot, type SourceStamp, type Authentication, type AuthenticationRecord, type AuthenticationAction, type InstanceStore } from './types';
export type { RenewalClaim, RenewalStore } from './renewal';
type Stored<T> = T | Promise<T>;

const text = z.string().min(1).max(4096);
const configuration = z.object({ schema: z.record(z.string(), z.json()), ui: z.object({
  order: z.array(z.string()).optional(), widgets: z.record(z.string(), z.enum(['password', 'textarea', 'uri'])).optional()
}).strict().optional() }).strict();
const expiry = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Invalid authentication expiry');
const authStep = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('waiting'), challengeId: text, expiresAt: expiry, message: text, qrCode: z.string().max(16_384).optional(),
    qrImage: z.string().max(350_000).regex(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/).optional(),
    url: z.url().refine(value => ['https:', 'http:'].includes(new URL(value).protocol)).optional() }).strict(),
  z.object({ kind: z.literal('input'), challengeId: text, expiresAt: expiry, message: text, configuration }).strict(),
  z.object({ kind: z.literal('complete'), accountName: z.string().max(500).optional() }).strict(),
  z.object({ kind: z.literal('expired'), message: text }).strict(),
  z.object({ kind: z.literal('cancelled') }).strict()
]);
const activeStep = (step: AuthStep | null): step is Extract<AuthStep, { kind: 'waiting' | 'input' }> => step?.kind === 'waiting' || step?.kind === 'input';
const stampOf = ({ id, pluginId, epoch, pluginRevision, pluginGeneration }: SourceStamp): SourceStamp => ({ id, pluginId, epoch, pluginRevision, pluginGeneration });
const publicAuthentication = ({ operationId, step, error }: Authentication): Authentication => ({ operationId, step, ...(error ? { error } : {}) });

export function createSources(store: InstanceStore & RenewalStore, registry: PluginRegistry, request: typeof fetch = fetch, now: () => number = Date.now) {
  const stale = () => new SourceError('stale_call', 'The source changed while this operation was running');
  const invalidAction = () => new SourceError('invalid_auth_action', 'Authentication operation or challenge is no longer current');
  // Native Worker fetch requires its global receiver even when a plugin invokes ctx.fetch().
  const pluginFetch = request.bind(globalThis);
  const context = (snapshot: InstanceSnapshot, signal: AbortSignal): Context => ({ instanceId: snapshot.id, config: snapshot.config,
    privateState: snapshot.privateState, signal, fetch: pluginFetch });
  async function capture(id: string) {
    const snapshot = await store.capture(id);
    if (!snapshot) throw new SourceError('missing_instance', 'Source instance is missing or its plugin is not active');
    return snapshot;
  }
  async function load(snapshot: InstanceSnapshot) {
    const loaded = await registry.get(snapshot.pluginId);
    if (loaded.revision !== snapshot.pluginRevision || loaded.generation !== snapshot.pluginGeneration) throw stale();
    return loaded.module;
  }
  async function invoke<T>(signal: AbortSignal, operation: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
    try { return await operation(); } catch {
      if (signal.aborted) throw signal.reason;
      throw new SourceError('plugin_failure', 'Source plugin failed unexpectedly');
    }
  }
  const currentAuthentication = (snapshot: InstanceSnapshot) => {
    const auth = snapshot.authentication;
    return auth && auth.stamp.id === snapshot.id && auth.stamp.pluginId === snapshot.pluginId && auth.stamp.epoch === snapshot.epoch && auth.stamp.pluginRevision === snapshot.pluginRevision
      && auth.stamp.pluginGeneration === snapshot.pluginGeneration ? auth : null;
  };
  const expired = (step: AuthStep | null) => activeStep(step) && Date.parse(step.expiresAt) <= now();
  async function expireAuthentication(snapshot: InstanceSnapshot, auth: AuthenticationRecord): Promise<Outcome<Authentication>> {
    const next: AuthenticationRecord = { operationId: auth.operationId, revision: auth.revision + 1,
      stamp: { ...stampOf(snapshot), epoch: snapshot.epoch + 1 }, step: { kind: 'expired', message: '授权已过期，请重新开始。' } };
    if (!await store.advanceAuthentication(snapshot, next)) throw stale();
    return { ok: true, value: publicAuthentication(next) };
  }

  async function authenticate(id: string, action: AuthenticationAction, signal: AbortSignal): Promise<Outcome<Authentication>> {
    signal.throwIfAborted();
    let snapshot = await capture(id); const plugin = await load(snapshot);
    signal.throwIfAborted();
    if (!plugin.authenticate) return { ok: false, error: { kind: 'not_supported', message: '此来源不需要认证。' } };
    let auth = currentAuthentication(snapshot); let pluginAction: AuthAction;
    if (action.kind === 'start') {
      auth = { operationId: crypto.randomUUID(), revision: 0, stamp: { ...stampOf(snapshot), epoch: snapshot.epoch + 1 }, step: null };
      if (!await store.advanceAuthentication(snapshot, auth)) throw stale();
      snapshot = await capture(id);
      if (currentAuthentication(snapshot)?.operationId !== auth.operationId || snapshot.epoch !== auth.stamp.epoch) throw stale();
      pluginAction = { kind: 'start' };
    } else {
      if (!auth || auth.operationId !== action.operationId) throw invalidAction();
      if (action.kind === 'cancel') {
        // The epoch changes BEFORE any upstream cleanup, so a slow poll cannot win after cancellation.
        if (auth.step && !activeStep(auth.step)) return { ok: true, value: publicAuthentication(auth) };
        const cancelled: AuthenticationRecord = { operationId: auth.operationId, revision: auth.revision + 1,
          stamp: { ...stampOf(snapshot), epoch: snapshot.epoch + 1 }, step: { kind: 'cancelled' } };
        if (!await store.advanceAuthentication(snapshot, cancelled)) throw stale();
        if (activeStep(auth.step)) {
          const challengeId = auth.step.challengeId;
          const latest = await capture(id);
          if (currentAuthentication(latest)?.operationId === cancelled.operationId && latest.epoch === cancelled.stamp.epoch) {
            // Cleanup failure does not undo the already committed cancellation.
            const cleanup = await invoke(signal, () => plugin.authenticate!(context(latest, signal), { kind: 'cancel', challengeId })).catch(() => null);
            if (!signal.aborted && cleanup?.ok && cleanup.value.kind === 'cancelled' && cleanup.nextPrivateState !== undefined
              && await registry.isCurrent(latest.pluginId, latest.pluginRevision, latest.pluginGeneration)) await store.saveState(latest, cleanup.nextPrivateState);
          }
        }
        return { ok: true, value: publicAuthentication(cancelled) };
      }
      if (!activeStep(auth.step) || action.challengeId !== auth.step.challengeId
        || action.kind === 'submit' && auth.step.kind !== 'input' || action.kind === 'poll' && auth.step.kind !== 'waiting') throw invalidAction();
      if (expired(auth.step)) return expireAuthentication(snapshot, auth);
      pluginAction = action.kind === 'poll' ? { kind: 'poll', challengeId: action.challengeId }
        : { kind: 'submit', challengeId: action.challengeId, input: action.input };
    }
    signal.throwIfAborted();
    const outcome = await invoke(signal, () => plugin.authenticate!(context(snapshot, signal), pluginAction));
    signal.throwIfAborted();
    if (!await store.current(snapshot) || !await registry.isCurrent(snapshot.pluginId, snapshot.pluginRevision, snapshot.pluginGeneration)) throw stale();
    if (expired(auth.step)) return expireAuthentication(snapshot, auth);
    let step: AuthStep | null = auth.step;
    if (outcome.ok) {
      const parsed = authStep.safeParse(outcome.value);
      if (!parsed.success) throw new SourceError('plugin_failure', 'Source plugin returned an invalid authentication step');
      step = parsed.data as AuthStep;
      if (expired(step)) return expireAuthentication(snapshot, auth);
    }
    const terminal = outcome.ok && step !== null && !activeStep(step);
    const next: AuthenticationRecord = { operationId: auth.operationId, revision: auth.revision + 1,
      stamp: { ...stampOf(snapshot), epoch: snapshot.epoch + (terminal ? 1 : 0) }, step, ...(!outcome.ok ? { error: outcome.error } : {}) };
    if (!await store.saveAuthentication(snapshot, next, outcome.nextPrivateState === undefined ? snapshot.privateState : outcome.nextPrivateState)) throw stale();
    return outcome.ok ? { ok: true, value: publicAuthentication(next) } : { ok: false, error: outcome.error };
  }

  async function execute<T>(
    id: string, signal: AbortSignal,
    operation: (plugin: SourcePlugin, ctx: Context) => Promise<Outcome<T>>,
    options: { discard?: (value: T) => Promise<void>; commit?: (snapshot: InstanceSnapshot, value: T, state: Json) => Stored<boolean> } = {}
  ): Promise<Outcome<T>> {
    signal.throwIfAborted();
    let snapshot = await capture(id); const plugin = await load(snapshot);
    if (!options.commit) {
      const prepared = await prepareSession({ initial: snapshot, plugin, store, context, now }, signal);
      if (!prepared.ok) return { ok: false, error: prepared.error };
      snapshot = prepared.value;
    }
    const outcome = await invoke(signal, () => operation(plugin, context(snapshot, signal)));
    const reject = async () => {
      if (outcome.ok && options.discard) await options.discard(outcome.value).catch(() => {});
      if (signal.aborted) throw signal.reason;
      throw stale();
    };
    if (signal.aborted || !await store.current(snapshot)
      || !await registry.isCurrent(snapshot.pluginId, snapshot.pluginRevision, snapshot.pluginGeneration)) return reject();
    if (options.commit && outcome.ok) {
      if (!await options.commit(snapshot, outcome.value,
        outcome.nextPrivateState === undefined ? snapshot.privateState : outcome.nextPrivateState)) return reject();
    } else if (outcome.nextPrivateState !== undefined && !await store.saveState(snapshot, outcome.nextPrivateState)) {
      return reject();
    }
    return outcome;
  }

  return {
    instances: async () => store.instances(),
    authenticate,
    async authentication(id: string): Promise<Authentication | null> {
      const snapshot = await capture(id); await load(snapshot);
      const auth = currentAuthentication(snapshot); if (!auth) return null;
      return expired(auth.step) ? { operationId: auth.operationId, step: { kind: 'expired', message: '授权已过期，请重新开始。' } } : publicAuthentication(auth);
    },
    async configuration(pluginId: string) {
      const plugin = (await registry.get(pluginId)).module;
      return { configuration: plugin.configuration, authentication: typeof plugin.authenticate === 'function', ...(plugin.statistics ? { statistics: plugin.statistics } : {}) };
    },
    async view(id: string): Promise<SourceStamp> {
      const captured = await store.capture(id);
      if (!captured) throw new SourceError('missing_instance', 'Source instance is missing or its plugin is not active');
      const { pluginId, epoch, pluginRevision, pluginGeneration } = captured;
      if (!await registry.isCurrent(pluginId, pluginRevision, pluginGeneration)) throw stale();
      return { id, pluginId, epoch, pluginRevision, pluginGeneration };
    },
    current: (stamp: SourceStamp) => store.current(stamp),
    async create(pluginId: string, name: string, config: Json, signal: AbortSignal): Promise<Outcome<Instance>> {
      signal.throwIfAborted();
      const loaded = await registry.get(pluginId);
      const id = crypto.randomUUID();
      const validated = await invoke(signal, () => loaded.module.validateConfig({ instanceId: id, config, privateState: null, signal, fetch: pluginFetch }, config));
      signal.throwIfAborted();
      if (!validated.ok) return validated;
      const instance: Instance = { id, pluginId, name, config: validated.value, epoch: 1 };
      if (!await registry.isCurrent(pluginId, loaded.revision, loaded.generation)
        || !await store.insert(instance, validated.nextPrivateState ?? null, loaded)) throw stale();
      return { ok: true, value: instance };
    },
    configure: (id: string, config: Json, signal: AbortSignal) =>
      execute(id, signal, (plugin, ctx) => plugin.validateConfig(ctx, config), {
        commit: (snapshot, value, state) => store.configure(snapshot, value, state)
      }),
    roots: (id: string, signal: AbortSignal, cursor?: string): Promise<Outcome<Page<Root>>> =>
      execute(id, signal, (plugin, ctx) => plugin.roots(ctx, cursor)),
    list: (id: string, directory: string, signal: AbortSignal, cursor?: string): Promise<Outcome<Page<Entry>>> =>
      execute(id, signal, (plugin, ctx) => plugin.list(ctx, directory, cursor)),
    stat: (id: string, file: string, signal: AbortSignal): Promise<Outcome<FileInfo>> =>
      execute(id, signal, (plugin, ctx) => plugin.stat(ctx, file)),
    open: (id: string, file: string, read: ReadRequest, signal: AbortSignal): Promise<Outcome<ReadResult>> =>
      execute(id, signal, (plugin, ctx) => plugin.open(ctx, file, read), { discard: value => value.body.cancel() }),
    delete: async (id: string) => store.deleteInstance(id)
  };
}

export type Sources = ReturnType<typeof createSources>;
export { preparePluginMigration, type MigrationInput, type PreparedMigration } from './migration';
