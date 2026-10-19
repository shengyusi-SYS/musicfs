import { mkdir, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SourcePlugin } from '@musicfs/plugin-api';
import {
  assertPluginModule, ExtensionError, type InstallationStore, type LoadedPlugin, type PluginRegistry, type PreparedPackage
} from '../../core/extensions';

/** Immutable revision paths avoid ESM cache collisions across installed versions. */
export function createDesktopPlugins(directory: string, store: InstallationStore) {
  const modules = new Map<string, SourcePlugin>();
  const revisionPath = (revision: string) => join(directory, revision);
  const load = async (revision: string, entry: string): Promise<SourcePlugin> => {
    const key = `${revision}/${entry}`;
    const cached = modules.get(key);
    if (cached) return cached;
    const location = pathToFileURL(join(revisionPath(revision), entry)).href;
    const imported: { default?: unknown } = await import(/* @vite-ignore */ location);
    assertPluginModule(imported.default);
    modules.set(key, imported.default);
    return imported.default;
  };
  const registry: PluginRegistry = {
    async get(id): Promise<LoadedPlugin> {
      const installation = await store.installation(id);
      if (!installation || installation.status !== 'active') throw new ExtensionError('missing_plugin', 'Plugin is not installed');
      const entry = installation.manifest.hosts.desktop;
      if (!entry) throw new ExtensionError('incompatible', 'Plugin does not support desktop');
      return { ...installation, module: await load(installation.revision, entry) };
    },
    async isCurrent(id, revision, generation) {
      const installation = await store.installation(id);
      return installation?.status === 'active' && installation.revision === revision && installation.generation === generation;
    }
  };

  return {
    registry,
    async prepare(prepared: PreparedPackage) {
      const entry = prepared.manifest.hosts.desktop;
      if (!entry) throw new ExtensionError('incompatible', 'Plugin does not support desktop');
      const staging = join(directory, `.staging-${crypto.randomUUID()}`);
      await mkdir(staging, { recursive: true });
      try {
        for (const [path, bytes] of prepared.files) {
          const target = join(staging, path);
          await mkdir(dirname(target), { recursive: true });
          await Bun.write(target, bytes);
        }
        // Filesystem revisions can be shared by retries; only a complete staging directory is published.
        try { await rename(staging, revisionPath(prepared.digest)); }
        catch (error) {
          if (!await Bun.file(join(revisionPath(prepared.digest), 'manifest.json')).exists()) throw error;
        }
        await load(prepared.digest, entry);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
  };
}
