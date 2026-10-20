import type { D1Database } from '@cloudflare/workers-types';
import type { FileInfo } from '@musicfs/plugin-api';
import netease from 'musicfs-netease-artifact';
import { createWorkerService } from '../../src/hosts/worker/service';

export default {
  async fetch(request: Request, env: { DB: D1Database }) {
    let statements = 0;
    const db = new Proxy(env.DB, { get(target, key) {
      if (key === 'prepare') return (sql: string) => { statements++; return target.prepare(sql); };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const unsupported = async (): Promise<never> => { throw new Error('Publication is outside this offline probe'); };
    const service = createWorkerService({ db, adminToken: 'fixture-admin', dav: { username: 'reader', password: 'fixture' },
      registrations: [{ id: 'org.musicfs.netease', revision: 'f'.repeat(64), module: netease }],
      changes: { install: unsupported, remove: unsupported, get: async () => null } });
    let result: Response;
    if (new URL(request.url).pathname === '/__open') {
      const input = await request.json() as { instanceId: string; fileRef: string; info: FileInfo; range?: { start: number; end: number } };
      const opened = await service.sources.open(input.instanceId, input.fileRef, { expectedContentId: input.info.contentId, ...(input.range ? { range: input.range } : {}) }, request.signal);
      result = opened.ok ? new Response(opened.value.body) : Response.json(opened.error, { status: 500 });
    } else result = await service.app.fetch(request);
    const response = new Response(result.body, result); response.headers.set('X-Probe-Queries', String(statements)); return response;
  }
};
