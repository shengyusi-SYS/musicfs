import type { D1Database } from '@cloudflare/workers-types';
import { createWorkerChanges } from './hosts/worker/changes';
import { createWorkerService, type WorkerAssets } from './hosts/worker/service';
import type { RegisteredPlugin } from './hosts/worker/plugins';
export { assertPluginModule } from './core/extensions';

declare const FixedLengthStream: { new(size: number): TransformStream<Uint8Array, Uint8Array> };

export type WorkerBindings = {
  DB: D1Database; ASSETS: WorkerAssets; ADMIN_TOKEN: string; DAV_USERNAME: string; DAV_PASSWORD: string;
  CF_ACCOUNT_ID: string; CF_WORKER_NAME: string; CF_API_TOKEN: string;
};
export default function createWorker(registrations: RegisteredPlugin[]) {
  return {
    fetch(request: Request, env: WorkerBindings, context: { waitUntil(promise: Promise<unknown>): void }) {
      const changes = createWorkerChanges({ db: env.DB, registrations, waitUntil: promise => context.waitUntil(promise),
        accountId: env.CF_ACCOUNT_ID, scriptName: env.CF_WORKER_NAME, apiToken: env.CF_API_TOKEN });
      const service = createWorkerService({ db: env.DB, registrations, adminToken: env.ADMIN_TOKEN,
        dav: { username: env.DAV_USERNAME, password: env.DAV_PASSWORD }, assets: env.ASSETS, changes,
        fixedLength: size => new FixedLengthStream(size) });
      return service.app.fetch(request);
    }
  };
}
