import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/bun';
import { createExtensions } from '../../core/extensions';
import { createSources } from '../../core/sources';
import { createLibrary } from '../../core/library';
import { openSqlite } from '../../infrastructure/persistence/sqlite';
import { readPackage, DEFAULT_PACKAGE_LIMITS } from '../../infrastructure/archives';
import { createManagementApi } from '../../transport/http';
import { createDav, type ReadCredentials } from '../../transport/dav';
import { createDesktopPlugins } from './plugins';
import type { MountManager } from '../../contracts/mounts';
import { createDesktopRefreshRunner } from './refresh';

export async function createDesktopService(input: { directory: string; adminToken: string; dav: ReadCredentials; webRoot?: string; mounts?: MountManager }) {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const store = openSqlite(join(input.directory, 'state.sqlite'));
  const host = createDesktopPlugins(join(input.directory, 'plugins'), store);
  const extensions = createExtensions(store, host.prepare);
  const sources = createSources(store, host.registry); const library = createLibrary(sources, store, undefined, { execution: 'deferred' });
  const refresh = createDesktopRefreshRunner(library);
  const app = new Hono();
  app.use('*', async (c, next) => {
    await next();
    if (c.res.headers.has('X-MusicFS-Refresh') || c.req.path.startsWith('/api/refreshes/')) refresh.wake();
  });
  app.route('/', createManagementApi({ host: 'desktop', adminToken: input.adminToken, sources, library, extensions,
    connection: { davPath: '/dav', ...input.dav },
    ...(input.mounts ? { mounts: input.mounts } : {}),
    maxPackageBytes: DEFAULT_PACKAGE_LIMITS.compressedBytes,
    install: async (archive, signal) => extensions.install(await readPackage(archive, 'desktop', signal)) }));
  app.route('/', createDav(library.files, input.dav));
  if (input.webRoot) {
    app.get('/', serveStatic({ root: input.webRoot, path: 'index.html' }));
    app.on(['GET', 'HEAD'], '/assets/*', serveStatic({ root: input.webRoot }));
  }
  refresh.wake();
  return { app, store, close: async () => { if (input.mounts) await input.mounts.close(); await refresh.close(); store.close(); } };
}
