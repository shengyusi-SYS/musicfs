import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { PluginChange } from '../../contracts/plugin-changes';
import { createSources } from '../../core/sources';
import { createLibrary } from '../../core/library';
import { createD1Store } from '../../infrastructure/persistence/d1';
import { DEFAULT_PACKAGE_LIMITS } from '../../infrastructure/archives';
import { createManagementApi } from '../../transport/http';
import { createDav, type DavOptions, type ReadCredentials } from '../../transport/dav';
import { createWorkerRegistry, type RegisteredPlugin } from './plugins';

export type WorkerPluginChanges = {
  install(archive: Uint8Array, signal: AbortSignal): Promise<PluginChange>;
  remove(id: string, signal: AbortSignal): Promise<PluginChange>;
  get(operationId: string): Promise<PluginChange | null>;
};
export type WorkerAssets = { fetch(request: Request): Promise<Response> };

/** The registry supplies executable code; only the publication use case activates it in D1. */
export function createWorkerService(input: {
  db: D1Database; registrations: RegisteredPlugin[]; adminToken: string; dav: ReadCredentials;
  changes: WorkerPluginChanges; assets?: WorkerAssets; fixedLength?: DavOptions['fixedLength'];
}) {
  const store = createD1Store(input.db);
  const registry = createWorkerRegistry(store, input.registrations);
  const sources = createSources(store, registry);
  const library = createLibrary(sources, store);
  const app = new Hono();
  app.route('/', createManagementApi({ host: 'worker', adminToken: input.adminToken, sources, library,
    extensions: { list: () => store.installations(), remove: async id => { await input.changes.remove(id, new AbortController().signal); } },
    connection: { davPath: '/dav', ...input.dav }, maxPackageBytes: DEFAULT_PACKAGE_LIMITS.compressedBytes,
    install: (archive, signal) => input.changes.install(archive, signal),
    remove: (id, signal) => input.changes.remove(id, signal), pluginChange: id => input.changes.get(id) }));
  app.route('/', createDav(library.files, input.dav, input.fixedLength ? { fixedLength: input.fixedLength } : {}));
  if (input.assets) {
    const assets = input.assets;
    app.on(['GET', 'HEAD'], ['/', '/assets/*'], c => assets.fetch(c.req.raw));
  }
  return { app, store, sources, library };
}
