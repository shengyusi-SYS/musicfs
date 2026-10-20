import { z } from 'zod';
import type { Json, PluginManifest, SourcePlugin } from '@musicfs/plugin-api';
import { ExtensionError } from '../extensions';

export type MigrationInput = {
  id: string; pluginId: string; name: string; config: Json; privateState: Json; epoch: number; stateRevision: number;
};
export type PreparedMigration = { config: Json; privateState: Json };
const json = z.json();
const invalid = () => new ExtensionError('incompatible', 'Plugin could not prepare a valid instance migration');
function copy(value: unknown): Json {
  const parsed = json.safeParse(value);
  if (!parsed.success) throw invalid();
  return structuredClone(parsed.data);
}

/** Produces isolated candidates only; activation and its compare-and-write belong to the caller. */
export async function preparePluginMigration(previous: PluginManifest, target: PluginManifest, module: SourcePlugin,
  input: MigrationInput, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<PreparedMigration> {
  signal.throwIfAborted();
  try {
    if (previous.id !== target.id || input.pluginId !== target.id) throw invalid();
    const changeConfig = previous.configVersion !== target.configVersion;
    const changeState = previous.stateVersion !== target.stateVersion;
    let config = copy(input.config); let state = copy(input.privateState);
    if (!changeConfig && !changeState) return { config, privateState: state };
    if (changeConfig && typeof module.migrateConfig !== 'function' || changeState && typeof module.migrateState !== 'function'
      || typeof module.validateState !== 'function') throw invalid();
    if (changeConfig) config = copy(module.migrateConfig!({ fromVersion: previous.configVersion, config: copy(config), state: copy(state) }));
    signal.throwIfAborted();
    if (changeState) state = copy(module.migrateState!({ fromVersion: previous.stateVersion, state: copy(state), config: copy(config) }));
    signal.throwIfAborted();
    const validateState = () => {
      if (module.validateState!({ config: copy(config), state: copy(state) }) !== true) throw invalid();
    };
    validateState(); signal.throwIfAborted();
    const request = fetcher.bind(globalThis);
    const pluginFetch = ((resource, init) => {
      signal.throwIfAborted();
      const requestedSignal = init?.signal ?? (resource instanceof Request ? resource.signal : undefined);
      return request(resource, { ...init, signal: requestedSignal ? AbortSignal.any([signal, requestedSignal]) : signal });
    }) as typeof fetch;
    const outcome = await module.validateConfig({ instanceId: input.id, config: copy(config), privateState: copy(state), signal, fetch: pluginFetch }, copy(config));
    signal.throwIfAborted();
    if (outcome.ok !== true) throw invalid();
    config = copy(outcome.value);
    if (outcome.nextPrivateState !== undefined) state = copy(outcome.nextPrivateState);
    validateState(); signal.throwIfAborted();
    return { config, privateState: state };
  } catch {
    // Never expose plugin exceptions, validation data or private state through an installation error.
    signal.throwIfAborted();
    throw invalid();
  }
}
