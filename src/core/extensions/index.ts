import { z } from 'zod';
import { valid, validRange, satisfies } from 'semver';
import type { HostKind, PluginManifest, SourcePlugin } from '@musicfs/plugin-api';

export const PLUGIN_API_VERSION = '0.1.9';

export class ExtensionError extends Error {
  constructor(public readonly code: 'invalid_package' | 'incompatible' | 'revision_conflict' | 'missing_plugin' | 'host_not_configured' | 'change_in_progress', message: string) {
    super(message);
    this.name = 'ExtensionError';
  }
}

/** Paths must have the same meaning on every supported installation host. */
export function isPackagePath(path: string): boolean {
  return path.length > 0 && !/[\\:\x00-\x1f]/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'
      && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

const packagePath = z.string().refine(isPackagePath, 'Invalid package path');
const manifestSchema = z.object({
  formatVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
  name: z.string().min(1).max(120),
  version: z.string().refine(v => valid(v) !== null, 'Invalid semantic version'),
  apiRange: z.string().min(1).refine(v => validRange(v) !== null, 'Invalid API range'),
  hosts: z.object({ desktop: packagePath.optional(), worker: packagePath.optional() }).strict(),
  configVersion: z.number().int().positive(),
  stateVersion: z.number().int().positive(),
  files: z.array(packagePath).min(1).max(256)
}).strict();

/** Validates the package declaration independently of the current installation host. */
export function parsePackageManifest(input: unknown): PluginManifest {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) throw new ExtensionError('invalid_package', 'Invalid plugin manifest');
  const manifest = parsed.data;
  const paths = new Set(manifest.files.map(path => path.toLowerCase()));
  if (paths.size !== manifest.files.length || paths.has('manifest.json')) {
    throw new ExtensionError('invalid_package', 'Duplicate or reserved package path');
  }
  if (Object.keys(manifest.hosts).length === 0) throw new ExtensionError('invalid_package', 'No supported host');
  for (const entry of Object.values(manifest.hosts)) {
    if (entry === undefined || !manifest.files.includes(entry) || !/\.(?:m?js)$/.test(entry)) {
      throw new ExtensionError('invalid_package', 'Host entry must name a declared JavaScript module');
    }
  }
  const hosts: PluginManifest['hosts'] = {};
  if (manifest.hosts.desktop) hosts.desktop = manifest.hosts.desktop;
  if (manifest.hosts.worker) hosts.worker = manifest.hosts.worker;
  return { ...manifest, hosts };
}

export function pluginCompatibility(manifest: PluginManifest, host: HostKind) {
  return { host, apiVersion: PLUGIN_API_VERSION, apiCompatible: satisfies(PLUGIN_API_VERSION, manifest.apiRange),
    hostCompatible: manifest.hosts[host] !== undefined };
}

export function parseManifest(input: unknown, host: HostKind): PluginManifest {
  const manifest = parsePackageManifest(input);
  const compatibility = pluginCompatibility(manifest, host);
  if (!compatibility.apiCompatible || !compatibility.hostCompatible) {
    throw new ExtensionError('incompatible', 'Plugin API or host is not supported');
  }
  return manifest;
}

export type PreparedPackage = { manifest: PluginManifest; digest: string; files: ReadonlyMap<string, Uint8Array> };
export type Installation = { manifest: PluginManifest; revision: string; generation: number; status: 'active' | 'missing' };
export type LoadedPlugin = Installation & { module: SourcePlugin };

export function assertInstallationCandidate(previous: Installation | undefined, prepared: PreparedPackage) {
  if (previous?.manifest.version === prepared.manifest.version && previous.revision !== prepared.digest) {
    throw new ExtensionError('revision_conflict', 'A different package already uses this plugin version');
  }
}

export interface InstallationStore {
  installations(): Installation[] | Promise<Installation[]>;
  installation(id: string): Installation | undefined | Promise<Installation | undefined>;
  activate(manifest: PluginManifest, revision: string, expectedGeneration: number | null): Installation | Promise<Installation>;
  markMissing(id: string, expectedGeneration: number): void | Promise<void>;
}

export interface PluginRegistry {
  get(id: string): Promise<LoadedPlugin>;
  isCurrent(id: string, revision: string, generation: number): Promise<boolean>;
}

/** Installation policy stays here; a host prepares immutable executable revisions. */
export function createExtensions(store: InstallationStore, prepare: (prepared: PreparedPackage) => Promise<void>) {
  return {
    list: () => store.installations(),
    async install(prepared: PreparedPackage): Promise<Installation> {
      const previous = await store.installation(prepared.manifest.id);
      assertInstallationCandidate(previous, prepared);
      if (previous && (previous.manifest.stateVersion !== prepared.manifest.stateVersion || previous.manifest.configVersion !== prepared.manifest.configVersion)) {
        throw new ExtensionError('incompatible', 'Use the coordinated installation path for schema migrations');
      }
      await prepare(prepared);
      return store.activate(prepared.manifest, prepared.digest, previous?.generation ?? null);
    },
    async remove(id: string) {
      const current = await store.installation(id);
      if (!current) throw new ExtensionError('missing_plugin', 'Plugin is not installed');
      await store.markMissing(id, current.generation);
    }
  };
}
export type Extensions = ReturnType<typeof createExtensions>;

export function assertPluginModule(value: unknown): asserts value is SourcePlugin {
  if (typeof value !== 'object' || value === null
    || !('configuration' in value) || typeof value.configuration !== 'object' || value.configuration === null
    || !('schema' in value.configuration)) {
    throw new ExtensionError('invalid_package', 'Plugin must export a configuration declaration');
  }
  const methods = ['validateConfig', 'roots', 'list', 'stat', 'open'] as const;
  if (methods.some(key => !(key in value) || typeof Reflect.get(value, key) !== 'function')) {
    throw new ExtensionError('invalid_package', 'Plugin does not implement the public contract');
  }
  for (const key of ['migrateConfig', 'migrateState', 'validateState']) {
    if (key in value && Reflect.get(value, key) !== undefined && typeof Reflect.get(value, key) !== 'function') {
      throw new ExtensionError('invalid_package', 'Optional plugin methods must be callable');
    }
  }
  if ('renewal' in value && value.renewal !== undefined) {
    const renewal = value.renewal;
    if (renewal === null || typeof renewal !== 'object' || typeof Reflect.get(renewal, 'needed') !== 'function'
      || typeof Reflect.get(renewal, 'renew') !== 'function') throw new ExtensionError('invalid_package', 'Plugin renewal must provide a local policy and a renewal operation');
  }
  if ('statistics' in value && value.statistics !== undefined) {
    const labels = z.record(z.string().min(1).max(64), z.string().min(1).max(80)).safeParse(value.statistics);
    if (!labels.success || Object.keys(labels.data).length > 100) throw new ExtensionError('invalid_package', 'Plugin statistics labels are invalid');
  }
}
