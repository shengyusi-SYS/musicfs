import type { Json, SourcePlugin } from '@musicfs/plugin-api';
import { parseManifest, type PluginRegistry } from '../../src/core/extensions';
import { createSources } from '../../src/core/sources';
import { createLibrary } from '../../src/core/library';
import { openSqlite } from '../../src/infrastructure/persistence/sqlite';
import rawManifest from '../../plugins/sample/manifest.json';

export async function libraryFixture(plugin: SourcePlugin, config: Json = {}) {
  const store = openSqlite(':memory:');
  store.activate(parseManifest(rawManifest, 'desktop'), 'a'.repeat(64), null);
  const registry: PluginRegistry = {
    async get(id) { const installed = store.installation(id); if (!installed || installed.status !== 'active') throw new Error('Missing fixture plugin'); return { ...installed, module: plugin }; },
    async isCurrent(id, revision, generation) { const installed = store.installation(id); return installed?.status === 'active' && installed.revision === revision && installed.generation === generation; }
  };
  const sources = createSources(store, registry);
  const created = await sources.create(rawManifest.id, '实例 & #', config, new AbortController().signal);
  if (!created.ok) throw new Error('Cannot create test instance');
  return { store, sources, library: createLibrary(sources, store), id: created.value.id, close: () => store.close() };
}
