import type { D1Database } from '@cloudflare/workers-types';
import { Hono } from 'hono';
import { createManagementAuth } from '../../src/infrastructure/management-auth';

let app: Hono | undefined;
export default {
  fetch(request: Request, env: { DB: D1Database }) {
    if (!app) {
      const access = createManagementAuth({ database: env.DB, adminToken: 'fixture-admin-01234567890123456789', instanceId: 'fixture' });
      app = new Hono();
      app.route('/', access.app);
      app.use('/api/private', access.middleware);
      app.get('/api/private', ctx => ctx.json({ ok: true }));
    }
    return app.fetch(request);
  },
};
