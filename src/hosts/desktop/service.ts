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

export async function createDesktopService(input: { directory: string; adminToken: string; dav: ReadCredentials; webRoot?: string; mounts?: MountManager }) {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const store = openSqlite(join(input.directory, 'state.sqlite'));
  const host = createDesktopPlugins(join(input.directory, 'plugins'), store);
  const extensions = createExtensions(store, host.prepare);
  const sources = createSources(store, host.registry); const library = createLibrary(sources, store);
  const app = new Hono();
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
  return { app, store, close: async () => { if (input.mounts) await input.mounts.close(); store.close(); } };
}
