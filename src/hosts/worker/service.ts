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
  waitUntil?: (promise: Promise<unknown>) => void;
}) {
  const store = createD1Store(input.db);
  const registry = createWorkerRegistry(store, input.registrations);
  const sources = createSources(store, registry);
  const library = createLibrary(sources, store, undefined, { execution: 'deferred' });
  const app = new Hono();
  app.use('*', async (c, next) => {
    await next();
    const pending = c.res.headers.get('X-MusicFS-Refresh');
    // One request may start one background page. Continuation requires a NEW
    // HTTP/scheduled invocation; waitUntil is never a recursive page runner.
    if (pending && (c.res.status === 202 || c.res.status === 503) && input.waitUntil) {
      input.waitUntil(library.refreshes.step(pending, AbortSignal.timeout(60_000)).catch(() => {}));
    }
  });
  app.route('/', createManagementApi({ host: 'worker', adminToken: input.adminToken, sources, library,
    extensions: { list: () => store.installations() },
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
