import type { D1Database } from '@cloudflare/workers-types';
import type { Entry, SourcePlugin } from '@musicfs/plugin-api';
import { createWorkerService } from '../../src/hosts/worker/service';

type Bindings = { DB: D1Database; PAGE_URL: string };
type Measurements = { statements: number; pages: number; roots: number; subrequests: number; stats: number };
const info = { contentId: 'fixture-complete-mp3-v1', size: 16044, mediaType: 'audio/mpeg' };

// This fixture exists only in the probe bundle, never in the product registry.
function plugin(pageUrl: string, measured: Measurements): SourcePlugin {
  return {
    configuration: { schema: { type: 'object', additionalProperties: false } },
    statistics: { tracks: 'Tracks', files: 'Files' },
    validateConfig: async (_ctx, value) => ({ ok: true, value }),
    async roots() {
      measured.roots++;
      return { ok: true, value: { items: [{ sourceId: 'large', name: 'Large', directoryRef: 'large' }] } };
    },
    async list(ctx, directory, cursor) {
      measured.pages++;
      if (directory !== 'large') return { ok: false, error: { kind: 'not_found', message: 'Unknown fixture directory' } };
      const offset = cursor === undefined ? 0 : Number(cursor.replace(/^fixture-page:/, ''));
      if (!Number.isInteger(offset) || offset < 0 || offset >= 4158 || offset % 100 !== 0
        || cursor !== undefined && cursor !== `fixture-page:${offset}`) {
        return { ok: false, error: { kind: 'unavailable', message: 'Invalid fixture cursor' } };
      }
      measured.subrequests++;
      const response = await ctx.fetch(new URL(`?offset=${offset}`, pageUrl), { signal: ctx.signal });
      if (!response.ok) throw new Error('Fixture byte endpoint failed');
      const edition = await response.text();
      if (edition === 'seed') return { ok: true, value: { items: [file('old', 'Old snapshot.mp3')], statistics: { tracks: 1, files: 1 } } };
      if (edition !== 'large') throw new Error('Unexpected fixture bytes');
      const count = Math.min(100, 4158 - offset);
      const items = Array.from({ length: count }, (_, index) => {
        const number = String(offset + index + 1).padStart(4, '0');
        return file(`track-${number}`, `Track ${number}.mp3`);
      });
      return { ok: true, value: { items, statistics: { tracks: count, files: count },
        ...(offset + count < 4158 ? { nextCursor: `fixture-page:${offset + count}` } : {}) } };
    },
    stat: async () => { measured.stats++; return { ok: true, value: info }; },
    open: async () => ({ ok: false, error: { kind: 'not_supported', message: 'Byte reads are outside this refresh probe' } })
  };
}
function file(id: string, name: string): Entry { return { kind: 'file', entryId: id, name, fileRef: id, info }; }

/** Count prepared statements individually, including every member of a D1 batch. */
function counted(db: D1Database, measured: Measurements): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => { measured.statements++; return target.prepare(sql); };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const measured: Measurements = { statements: 0, pages: 0, roots: 0, subrequests: 0, stats: 0 };
    const background: Promise<unknown>[] = [];
    const unsupported = async (): Promise<never> => { throw new Error('Plugin publication is outside this refresh probe'); };
    const service = createWorkerService({ db: counted(env.DB, measured), adminToken: 'fixture-admin',
      dav: { username: 'reader', password: 'fixture-password' },
      registrations: [{ id: 'org.musicfs.test.refresh', revision: 'e'.repeat(64), module: plugin(env.PAGE_URL, measured) }],
      changes: { install: unsupported, remove: unsupported, get: async () => null },
      ...(request.headers.get('X-Probe-WaitUntil') === 'drain' ? { waitUntil: (promise: Promise<unknown>) => { background.push(promise); } } : {})
    });
    const result = await service.app.fetch(request);
    // A probe-only switch drains the real service's scheduled work before reporting counts.
    // Ordinary requests still exercise explicit steps without an automatic runner.
    await Promise.all(background);
    const response = new Response(result.body, result);
    response.headers.set('X-Probe-D1-statements', String(measured.statements));
    response.headers.set('X-Probe-plugin-pages', String(measured.pages));
    response.headers.set('X-Probe-plugin-roots', String(measured.roots));
    response.headers.set('X-Probe-subrequests', String(measured.subrequests));
    response.headers.set('X-Probe-background-tasks', String(background.length));
    response.headers.set('X-Probe-plugin-stats', String(measured.stats));
    return response;
  }
};
