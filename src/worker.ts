import type { D1Database } from '@cloudflare/workers-types';
import { createWorkerChanges } from './hosts/worker/changes';
import { createWorkerRuntime, createWorkerService, type WorkerAssets, type WorkerRuntime } from './hosts/worker/service';
import type { RegisteredPlugin } from './hosts/worker/plugins';
import { createManagementAuth, type ManagementAuth } from './infrastructure/management-auth';
export { assertPluginModule } from './core/extensions';

declare const FixedLengthStream: { new(size: number): TransformStream<Uint8Array, Uint8Array> };

export type WorkerBindings = {
  DB: D1Database; ASSETS: WorkerAssets; ADMIN_TOKEN: string; DAV_USERNAME: string; DAV_PASSWORD: string;
  CF_ACCOUNT_ID: string; CF_WORKER_NAME: string; CF_API_TOKEN: string;
};
export default function createWorker(registrations: RegisteredPlugin[]) {
  const runtimes = new WeakMap<D1Database, WorkerRuntime>();
  const authentications = new WeakMap<D1Database, { token: string; service: ManagementAuth }>();
  const runtime = (db: D1Database) => {
    let value = runtimes.get(db);
    if (!value) { value = createWorkerRuntime(db, registrations); runtimes.set(db, value); }
    return value;
  };
  const authentication = (env: WorkerBindings) => {
    let value = authentications.get(env.DB);
    if (!value || value.token !== env.ADMIN_TOKEN) {
      value = { token: env.ADMIN_TOKEN, service: createManagementAuth({ database: env.DB, adminToken: env.ADMIN_TOKEN }) };
      authentications.set(env.DB, value);
    }
    return value.service;
  };
  return {
    fetch(request: Request, env: WorkerBindings, context: { waitUntil(promise: Promise<unknown>): void }) {
      const changes = createWorkerChanges({ db: env.DB, registrations, waitUntil: promise => context.waitUntil(promise),
        accountId: env.CF_ACCOUNT_ID, scriptName: env.CF_WORKER_NAME, apiToken: env.CF_API_TOKEN });
      const service = createWorkerService({ db: env.DB, registrations, adminToken: env.ADMIN_TOKEN,
        dav: { username: env.DAV_USERNAME, password: env.DAV_PASSWORD }, assets: env.ASSETS, changes,
        runtime: runtime(env.DB), authentication: authentication(env),
        fixedLength: size => new FixedLengthStream(size), waitUntil: promise => context.waitUntil(promise) });
      return service.app.fetch(request);
    },
    async scheduled(_event: unknown, env: WorkerBindings) {
      const changes = createWorkerChanges({ db: env.DB, registrations, waitUntil: () => {},
        accountId: env.CF_ACCOUNT_ID, scriptName: env.CF_WORKER_NAME, apiToken: env.CF_API_TOKEN });
      const signal = AbortSignal.timeout(60_000);
      if (await changes.stepNext(signal)) return;
      // The native scheduler is a slow fallback when no management page is open.
      const { library } = runtime(env.DB);
      // Link overlapping due rules before advancing catalogue work.
      if (await library.schedules.stepNext(signal)) return;
      await library.refreshes.stepNext(signal);
    }
  };
}
