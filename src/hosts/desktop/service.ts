import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/bun';
import { createExtensions } from '../../core/extensions';
import { createSources } from '../../core/sources';
import { createLibrary } from '../../core/library';
import { publishedPaths } from '../../core/library/published-paths';
import { openSqlite } from '../../infrastructure/persistence/sqlite';
import { sha256 } from '../../infrastructure/sha256';
import { readPackage, DEFAULT_PACKAGE_LIMITS } from '../../infrastructure/archives';
import { createManagementApi } from '../../transport/http';
import { createDav, type ReadCredentials } from '../../transport/dav';
import { createDesktopPlugins } from './plugins';
import type { MountManager } from '../../contracts/mounts';
import { createDesktopRunner } from './background';
import { createDesktopChanges } from './changes';
import { createDesktopReadCache } from './read-cache';
import type { RcloneControl } from './rclone-control';
import { createDesktopAccess } from './access';
import { createDesktopDavAccess } from './dav-access';
import { getLogger } from '@logtape/logtape';
import { errorFields } from '../../infrastructure/logging';
import { observeFetch, observeSources } from '../../infrastructure/io-diagnostics';
import { createDesktopDiagnosticsHttp } from './diagnostics-http';
import type { DesktopLogging } from './logging';

const logger = getLogger(['musicfs', 'mounts']);

export async function createDesktopService(input: { directory: string; adminToken: string; instanceId?: string; dav: ReadCredentials; webRoot?: string; logging?: DesktopLogging; mounts?: MountManager; mountAction?: (id: string) => void; readCache?: { control: RcloneControl; controlDirectory: string } }) {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const davAccess = await createDesktopDavAccess(input.directory, input.dav);
  const database = openSqlite(join(input.directory, 'state.sqlite'));
  let wake = () => {};
  // Wake only after durable writes succeed. Every caller uses this store,
  // including private listeners; HTTP routes do not own background execution.
  const store = { ...database,
    createRefresh(...args: Parameters<typeof database.createRefresh>) {
      const saved = database.createRefresh(...args); wake(); return saved;
    },
    commitRefresh(...args: Parameters<typeof database.commitRefresh>) {
      const saved = database.commitRefresh(...args); if (saved === 'committed') wake(); return saved;
    },
    cancelRefresh(...args: Parameters<typeof database.cancelRefresh>) { database.cancelRefresh(...args); wake(); },
    createScheduledRefresh(...args: Parameters<typeof database.createScheduledRefresh>) {
      const saved = database.createScheduledRefresh(...args); if (saved) wake(); return saved;
    },
    saveUpdateRule(...args: Parameters<typeof database.saveUpdateRule>) { const saved = database.saveUpdateRule(...args); wake(); return saved; },
    removeUpdateRule(...args: Parameters<typeof database.removeUpdateRule>) { database.removeUpdateRule(...args); wake(); },
    finishUpdateRule(...args: Parameters<typeof database.finishUpdateRule>) { database.finishUpdateRule(...args); wake(); },
    createChange(...args: Parameters<typeof database.createChange>) {
      const saved = database.createChange(...args); if (saved) wake(); return saved;
    },
    commitChange(...args: Parameters<typeof database.commitChange>) {
      const saved = database.commitChange(...args); if (saved) wake(); return saved;
    }
  };
  const access = createDesktopAccess(input.directory, input.adminToken, input.instanceId);
  const host = createDesktopPlugins(join(input.directory, 'plugins'), store);
  const extensions = createExtensions(store, host.prepare);
  const refreshMounts = () => { void input.mounts?.refreshLocal().catch(error => logger.warning('Mount directory refresh failed', errorFields(error))); };
  const sources = observeSources(createSources({ ...store,
    insert(...args: Parameters<typeof store.insert>) { const saved = store.insert(...args); if (saved) refreshMounts(); return saved; },
    configure(...args: Parameters<typeof store.configure>) { const saved = store.configure(...args); if (saved && !args[3]) refreshMounts(); return saved; },
    advanceAuthentication(...args: Parameters<typeof store.advanceAuthentication>) {
      const saved = store.advanceAuthentication(...args); if (saved) refreshMounts(); return saved;
    },
    saveAuthentication(...args: Parameters<typeof store.saveAuthentication>) {
      const saved = store.saveAuthentication(...args);
      if (saved && args[1].stamp.epoch !== args[0].epoch) refreshMounts();
      return saved;
    },
    deleteInstance(id: string) { store.deleteInstance(id); refreshMounts(); }
  }, host.registry, observeFetch(fetch, 'source', process.env)));
  const library = createLibrary(sources, { ...store,
    saveLayout(...args: Parameters<typeof store.saveLayout>) { const saved = store.saveLayout(...args); if (saved) refreshMounts(); return saved; },
    saveFileNamingPolicy(...args: Parameters<typeof store.saveFileNamingPolicy>) {
      const saved = store.saveFileNamingPolicy(...args);
      if (saved && input.mounts) void sources.view(args[0]).then(stamp => publishedPaths(sources, store, stamp,
        args[1] === undefined ? { kind: 'roots', ref: '' } : { kind: 'directory', ref: args[1] }))
        .then(paths => input.mounts!.refreshLocal(paths)).catch(error => logger.warning('Renamed folder notification failed', errorFields(error)));
      return saved;
    },
    commitRefresh(...args: Parameters<typeof store.commitRefresh>) {
      const task = input.mounts && args[2]?.publish ? args[0].task : null;
      const previousId = task ? store.snapshotHeader(args[0].stamp.id, task.key)?.id : undefined;
      const result = store.commitRefresh(...args);
      // Preserve mounted listings when a successful refresh publishes unchanged contents.
      if (result === 'committed' && task && store.snapshotHeader(args[0].stamp.id, task.key)?.id !== previousId) {
        void publishedPaths(sources, store, args[0].stamp, task.key).then(paths => input.mounts!.refreshLocal(paths))
          .catch(error => logger.warning('Changed folder notification failed', errorFields(error)));
      }
      return result;
    } }, undefined, { execution: 'deferred', sha256, publishedViews: { views: 32, estimatedBytes: 32 * 1024 * 1024 } });
  const changes = createDesktopChanges({ store: { ...store, commitChange(...args: Parameters<typeof store.commitChange>) {
    const result = store.commitChange(...args);
    if (result && args[2].kind === 'activate') refreshMounts();
    return result;
  } }, plugins: host, extensions });
  const background = createDesktopRunner(async signal => {
    const changed = await changes.stepNext(signal);
    if (changed) return true;
    const refresh = await library.schedules.stepNext(signal) || await library.refreshes.stepNext(signal);
    if (refresh) {
      const failure = refresh.error ?? refresh.failures[0]?.error;
      const fields = { operationId: refresh.operationId, instanceId: refresh.instanceId, status: refresh.status,
        pages: refresh.current?.pages, failures: refresh.failures.length, retryAt: refresh.retryAt,
        ...(failure ? { errorCode: failure.code, sourceFaultKind: failure.sourceFault?.kind } : {}) };
      const progress = getLogger(['musicfs', 'io', 'refresh']);
      if (refresh.status === 'failed' || refresh.failures.length) progress.warning('Refresh contains failures', fields);
      else if (refresh.status === 'completed') progress.info('Refresh completed', fields);
      else progress.debug('Refresh checkpoint', fields);
    }
    return Boolean(refresh);
  }, async () => {
    const instants = [store.nextBackgroundWorkAt(), await library.schedules.nextAt()].filter((value): value is number => value !== null);
    return instants.length ? Math.min(...instants) : null;
  });
  wake = background.wake;
  const readCache = input.readCache ? await createDesktopReadCache({ directory: join(input.directory, 'read-cache'),
    ...input.readCache, view: library.files, current: file => sources.current(file.handle.stamp) }) : undefined;
  const app = new Hono();
  app.route('/', access.app);
  if (input.logging) app.route('/', createDesktopDiagnosticsHttp({ logging: input.logging, adminToken: input.adminToken, managementAuth: access.middleware }));
  app.route('/', createManagementApi({ host: 'desktop', adminToken: input.adminToken, managementAuth: access.middleware, sources, library, extensions,
    davAccess,
    ...(input.mounts ? { mounts: input.mounts } : {}),
    ...(input.mountAction ? { mountAction: input.mountAction } : {}),
    maxPackageBytes: DEFAULT_PACKAGE_LIMITS.compressedBytes,
    install: async (archive, signal) => {
      const installed = await changes.install(await readPackage(archive, 'desktop', signal), signal);
      if (!('operationId' in installed)) refreshMounts();
      return installed;
    },
    remove: async id => { await extensions.remove(id); refreshMounts(); }, pluginChange: id => changes.get(id) }));
  const davApp = createDav(readCache?.files ?? library.files, davAccess.get);
  app.route('/', davApp);
  if (input.webRoot) {
    app.get('/', serveStatic({ root: input.webRoot, path: 'index.html' }));
    app.on(['GET', 'HEAD'], '/assets/*', serveStatic({ root: input.webRoot }));
  }
  background.wake();
  return { app, davApp, store, readCache, access, davAccess, close: async () => {
    const resume = readCache?.prepareQuit();
    try {
      if (input.mounts) await input.mounts.close();
      await readCache?.close(); await input.readCache?.control.close(); await background.close(); store.close(); access.close();
    } catch (error) { resume?.(); throw error; }
  } };
}
