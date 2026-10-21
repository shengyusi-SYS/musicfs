import type { D1Database } from '@cloudflare/workers-types';
import { createWorkerChanges } from './hosts/worker/changes';
import { createWorkerRuntime, createWorkerService, type WorkerAssets, type WorkerRuntime } from './hosts/worker/service';
import type { RegisteredPlugin } from './hosts/worker/plugins';
export { assertPluginModule } from './core/extensions';

declare const FixedLengthStream: { new(size: number): TransformStream<Uint8Array, Uint8Array> };

export type WorkerBindings = {
  DB: D1Database; ASSETS: WorkerAssets; ADMIN_TOKEN: string; DAV_USERNAME: string; DAV_PASSWORD: string;
  CF_ACCOUNT_ID: string; CF_WORKER_NAME: string; CF_API_TOKEN: string;
};
export default function createWorker(registrations: RegisteredPlugin[]) {
  const runtimes = new WeakMap<D1Database, WorkerRuntime>();
  const runtime = (db: D1Database) => {
    let value = runtimes.get(db);
    if (!value) { value = createWorkerRuntime(db, registrations); runtimes.set(db, value); }
    return value;
  };
  return {
    fetch(request: Request, env: WorkerBindings, context: { waitUntil(promise: Promise<unknown>): void }) {
      const changes = createWorkerChanges({ db: env.DB, registrations, waitUntil: promise => context.waitUntil(promise),
        accountId: env.CF_ACCOUNT_ID, scriptName: env.CF_WORKER_NAME, apiToken: env.CF_API_TOKEN });
      const service = createWorkerService({ db: env.DB, registrations, adminToken: env.ADMIN_TOKEN,
        dav: { username: env.DAV_USERNAME, password: env.DAV_PASSWORD }, assets: env.ASSETS, changes,
        runtime: runtime(env.DB),
        fixedLength: size => new FixedLengthStream(size), waitUntil: promise => context.waitUntil(promise) });
      return service.app.fetch(request);
    },
    async scheduled(_event: unknown, env: WorkerBindings) {
      const changes = createWorkerChanges({ db: env.DB, registrations, waitUntil: () => {},
        accountId: env.CF_ACCOUNT_ID, scriptName: env.CF_WORKER_NAME, apiToken: env.CF_API_TOKEN });
      const signal = AbortSignal.timeout(60_000);
      if (await changes.stepNext(signal)) return;
      // The native scheduler is a slow fallback when no management page is open.
      await runtime(env.DB).library.refreshes.stepNext(signal);
    }
  };
}
