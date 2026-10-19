import type { SourcePlugin } from '@musicfs/plugin-api';
import { assertPluginModule, ExtensionError, type InstallationStore, type PluginRegistry } from '../../core/extensions';

export type RegisteredPlugin = { id: string; revision: string; module: SourcePlugin };

/** Deployment supplies code; persistent activation chooses an exact available revision. */
export function createWorkerRegistry(store: InstallationStore, registrations: RegisteredPlugin[]): PluginRegistry {
  const modules = new Map(registrations.map(item => {
    assertPluginModule(item.module);
    return [`${item.id}/${item.revision}`, item.module] as const;
  }));
  return {
    async get(id) {
      const installed = await store.installation(id);
      if (!installed || installed.status !== 'active') throw new ExtensionError('missing_plugin', 'Plugin is not installed');
      const module = modules.get(`${id}/${installed.revision}`);
      if (!module) throw new ExtensionError('missing_plugin', 'The running Worker does not contain the active plugin revision');
      return { ...installed, module };
    },
    async isCurrent(id, revision, generation) {
      const installed = await store.installation(id);
      return installed?.status === 'active' && installed.revision === revision && installed.generation === generation
        && modules.has(`${id}/${revision}`);
    }
  };
}
