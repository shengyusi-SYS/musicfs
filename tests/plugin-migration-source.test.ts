import { expect, test } from 'bun:test';
import { z } from 'zod';
import type { Json, PluginManifest, SourcePlugin } from '@musicfs/plugin-api';
import { preparePluginMigration, type MigrationInput } from '../src/core/sources';

const privateValue = 'PRIVATE-MIGRATION-FIXTURE';
const previous: PluginManifest = { formatVersion: 1, id: 'org.musicfs.migration-fixture', name: 'Migration fixture', version: '1.0.0',
  apiRange: '^0.1.3', hosts: { desktop: 'index.mjs', worker: 'index.mjs' }, configVersion: 1, stateVersion: 1, files: ['index.mjs'] };
const target: PluginManifest = { ...previous, version: '2.0.0', configVersion: 2, stateVersion: 2 };
const input = (): MigrationInput => ({ id: 'retained-instance', pluginId: previous.id, name: '保留实例',
  config: { oldLabel: '  renamed  ' }, privateState: { token: privateValue }, epoch: 4, stateRevision: 9 });
const signal = () => new AbortController().signal;
const configuration = z.object({ label: z.string().min(1) });
const privateState = z.object({ credential: z.object({ token: z.string().min(1) }) });

function plugin(overrides: Partial<SourcePlugin> = {}): SourcePlugin {
  const unused = async () => ({ ok: false as const, error: { kind: 'not_supported' as const, message: 'Unused migration fixture operation' } });
  return {
    configuration: { schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } },
    migrateConfig({ fromVersion, config }) {
      if (fromVersion !== 1) throw new Error('Unsupported fixture config version');
      const parsed = z.object({ oldLabel: z.string() }).parse(config);
      return { label: parsed.oldLabel };
    },
    migrateState({ fromVersion, state, config }) {
      if (fromVersion !== 1 || !configuration.safeParse(config).success) throw new Error('Unsupported fixture state migration');
      return { credential: { token: z.object({ token: z.string() }).parse(state).token } };
    },
    validateState: ({ config, state }) => configuration.safeParse(config).success && privateState.safeParse(state).success,
    validateConfig: async (_ctx, candidate) => {
      const parsed = configuration.safeParse(candidate);
      return parsed.success ? { ok: true, value: { label: parsed.data.label.trim() } }
        : { ok: false, error: { kind: 'invalid_config', message: 'Invalid fixture label' } };
    },
    roots: unused, list: unused, stat: unused, open: unused,
    ...overrides
  };
}

test('prepares v2 configuration and state, validates before/after the candidate call, and accepts renewed state', async () => {
  const source = plugin(); const trace: string[] = []; const captured = input(); const requestSignal = signal();
  const migrateConfig = source.migrateConfig!; const migrateState = source.migrateState!; const validateState = source.validateState!;
  source.migrateConfig = value => { trace.push('config'); return migrateConfig(value); };
  source.migrateState = value => { trace.push('state'); expect(value.config).toEqual({ label: '  renamed  ' }); return migrateState(value); };
  source.validateState = value => { trace.push('validate-state'); return validateState(value); };
  source.validateConfig = async (ctx, candidate) => {
    trace.push('validate-config');
    expect(ctx.instanceId).toBe(captured.id); expect(ctx.signal).toBe(requestSignal);
    expect(ctx.config).toEqual(candidate); expect(ctx.privateState).toEqual({ credential: { token: privateValue } });
    expect(await (await ctx.fetch('https://migration.invalid/check')).text()).toBe('fixture');
    return { ok: true, value: { label: configuration.parse(candidate).label.trim() }, nextPrivateState: { credential: { token: 'renewed-fixture' } } };
  };
  let requests = 0;
  const fetcher = function (this: unknown, _resource: Parameters<typeof fetch>[0], init?: RequestInit) {
    requests++; expect(this).toBe(globalThis); expect(init?.signal).toBe(requestSignal);
    return Promise.resolve(new Response('fixture'));
  } as typeof fetch;
  expect(await preparePluginMigration(previous, target, source, captured, requestSignal, fetcher)).toEqual({
    config: { label: 'renamed' }, privateState: { credential: { token: 'renewed-fixture' } }
  });
  expect(trace).toEqual(['config', 'state', 'validate-state', 'validate-config', 'validate-state']); expect(requests).toBe(1);
  expect(captured).toEqual(input());
});

test('unchanged schemas require no hooks, and each changed schema requires only its own conversion', async () => {
  const captured = input();
  const old = plugin({ validateConfig: async () => { throw new Error('Unchanged schemas must not invoke candidate validation'); } });
  delete old.migrateConfig; delete old.migrateState; delete old.validateState;
  const unchanged = await preparePluginMigration(previous, previous, old, captured, signal());
  expect(unchanged).toEqual({ config: captured.config, privateState: captured.privateState });
  expect(unchanged.config).not.toBe(captured.config); expect(unchanged.privateState).not.toBe(captured.privateState);
  const configOnly = plugin({ validateState: ({ state }) => z.object({ token: z.string() }).safeParse(state).success });
  delete configOnly.migrateState;
  expect(await preparePluginMigration(previous, { ...target, stateVersion: 1 }, configOnly, captured, signal())).toEqual({
    config: { label: 'renamed' }, privateState: captured.privateState
  });
  const stateOnly = plugin({ configuration: { schema: { type: 'object', properties: { oldLabel: { type: 'string' } }, required: ['oldLabel'] } },
    migrateState: ({ state }) => ({ credential: { token: z.object({ token: z.string() }).parse(state).token } }),
    validateState: ({ state }) => privateState.safeParse(state).success, validateConfig: async (_ctx, candidate) => ({ ok: true, value: candidate }) });
  delete stateOnly.migrateConfig;
  expect(await preparePluginMigration(previous, { ...target, configVersion: 1 }, stateOnly, captured, signal())).toEqual({
    config: captured.config, privateState: { credential: { token: privateValue } }
  });
});

test('missing required hooks, invalid Json, rejected state and plugin faults expose only the generic migration error', async () => {
  const sources = (['migrateConfig', 'migrateState', 'validateState'] as const).map(method => { const source = plugin(); delete source[method]; return source; });
  sources.push(
    plugin({ migrateState: () => ({ invalid: Infinity }) }),
    plugin({ validateConfig: async () => ({ ok: false, error: { kind: 'invalid_config', message: privateValue } }) }),
    plugin({ migrateState: () => { throw new Error(privateValue); } }),
    plugin({ validateConfig: async (_ctx, candidate) => ({ ok: true, value: candidate, nextPrivateState: { invalid: privateValue } }) })
  );
  for (const source of sources) {
    const captured = input(); const error = await preparePluginMigration(previous, target, source, captured, signal()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'incompatible', message: 'Plugin could not prepare a valid instance migration' });
    expect(String(error)).not.toContain(privateValue); expect(JSON.stringify(error)).not.toContain(privateValue);
    expect(error).not.toHaveProperty('cause'); expect(captured).toEqual(input());
  }
});

test('mutating hook arguments and retained return objects never mutates the captured input or prepared result', async () => {
  const captured = input(); const returnedStates: { credential: { token: string } }[] = [];
  const source = plugin({
    migrateConfig({ config, state }) {
      const value = config as Record<string, Json>; value.label = value.oldLabel!; delete value.oldLabel;
      (state as Record<string, Json>).token = 'ignored-state-mutation';
      return value;
    },
    migrateState({ state }) { const value = { credential: { token: z.object({ token: z.string() }).parse(state).token } }; returnedStates.push(value); return value; },
    validateState({ state }) {
      const valid = privateState.safeParse(state).success;
      (state as { credential: { token: string } }).credential.token = 'ignored-validator-mutation'; return valid;
    },
    validateConfig: async (ctx, candidate) => {
      (ctx.privateState as { credential: { token: string } }).credential.token = 'ignored-context-mutation';
      (candidate as { label: string }).label = 'normalized'; return { ok: true, value: candidate };
    }
  });
  const prepared = await preparePluginMigration(previous, target, source, captured, signal());
  expect(prepared).toEqual({ config: { label: 'normalized' }, privateState: { credential: { token: privateValue } } });
  expect(captured).toEqual(input());
  returnedStates[0]!.credential.token = 'late-mutation';
  expect(prepared.privateState).toEqual({ credential: { token: privateValue } });
});

test('cancelling a migration reaches candidate fetch and does not return prepared state', async () => {
  const controller = new AbortController(); const started = Promise.withResolvers<void>(); const captured = input();
  const source = plugin({ validateConfig: async (ctx, candidate) => { await ctx.fetch('https://migration.invalid/pending'); return { ok: true, value: candidate }; } });
  const fetcher = ((_resource, init) => new Promise<Response>((_resolve, reject) => {
    started.resolve(); init!.signal!.addEventListener('abort', () => reject(new Error(privateValue)), { once: true });
  })) as typeof fetch;
  const observed = preparePluginMigration(previous, target, source, captured, controller.signal, fetcher).then(() => null, (error: unknown) => error);
  await started.promise; const reason = new Error('Fixture migration cancelled'); controller.abort(reason);
  expect(await observed).toBe(reason); expect(captured).toEqual(input());
});
