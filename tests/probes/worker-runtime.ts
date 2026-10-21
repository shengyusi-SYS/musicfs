import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { SourcePlugin } from '@musicfs/plugin-api';
import createWorker, { type WorkerBindings } from '../../src/worker';
import { snapshotEntriesSQL } from '../../src/infrastructure/persistence/refresh-sql';

const info = { contentId: 'fixture-fixed', size: 8, mediaType: 'audio/wav' };
const plugin: SourcePlugin = {
  configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, value) => ({ ok: true, value }),
  roots: async () => ({ ok: true, value: { items: [{ sourceId: 'music', name: '音乐', directoryRef: 'music' }] } }),
  list: async (_ctx, ref) => ({ ok: true, value: { items: [{ kind: 'file', entryId: ref, name: 'prepared.wav', fileRef: ref, info }] } }),
  stat: async () => ({ ok: true, value: info }),
  open: async (_ctx, _file, input) => ({ ok: true, value: { content: info, servedRange: input.range ?? null,
    body: new Blob([input.range ? 'CD' : 'ABCDEFGH']).stream() } })
};
const worker = createWorker([{ id: 'org.musicfs.runtime-fixture', revision: 'a'.repeat(64), module: plugin }]);
type Measurements = { id: number; reads: number; rows: number; statements: number; delayNextSnapshot?: boolean };
const databases = new WeakMap<D1Database, { db: D1Database; measurements: Measurements }>();
let bindingIds = 0;
function counted(db: D1Database) {
  let value = databases.get(db);
  if (value) return value;
  const measurements: Measurements = { id: ++bindingIds, reads: 0, rows: 0, statements: 0 };
  const statement = (input: D1PreparedStatement, snapshot: boolean): D1PreparedStatement => new Proxy(input, {
    get(target, key) {
      if (key === 'bind') return (...args: unknown[]) => statement(target.bind(...args), snapshot);
      if (key === 'all' && snapshot) return async () => {
        measurements.reads++;
        if (measurements.delayNextSnapshot) { delete measurements.delayNextSnapshot; await new Promise(resolve => setTimeout(resolve, 25)); }
        const result = await target.all(); measurements.rows += result.results.length; return result;
      };
      const member = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
    }
  });
  const proxy = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => { measurements.statements++; return statement(target.prepare(sql), sql === snapshotEntriesSQL); };
    const member = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  value = { db: proxy, measurements }; databases.set(db, value); return value;
}

/** Test instrumentation wraps the actual product factory; no alternate service/controller lifecycle. */
export default {
  async fetch(request: Request, env: WorkerBindings, context: { waitUntil(work: Promise<unknown>): void }) {
    const { db, measurements } = counted(env.DB);
    if (request.headers.get('X-Probe-Cold-Delay')) measurements.delayNextSnapshot = true;
    const previous = { ...measurements }; const work: Promise<unknown>[] = [];
    const rotated = request.headers.get('X-Probe-Credentials') === 'rotated';
    const assetsMarker = request.headers.get('X-Probe-Assets') ?? 'initial';
    const response = await worker.fetch(request, { ...env, DB: db,
      ADMIN_TOKEN: rotated ? 'rotated-admin' : 'fixture-admin', DAV_USERNAME: 'reader', DAV_PASSWORD: rotated ? 'rotated-password' : 'fixture-password',
      ASSETS: { fetch: async () => new Response(assetsMarker) } }, {
      waitUntil(promise) { work.push(promise); context.waitUntil(promise); }
    });
    // Probe-only: complete this invocation's background page before reporting its ownership/count.
    await Promise.all(work);
    const result = new Response(response.body, response);
    result.headers.set('X-Probe-Binding', String(measurements.id));
    result.headers.set('X-Probe-Snapshot-Reads', String(measurements.reads - previous.reads));
    result.headers.set('X-Probe-Snapshot-Rows', String(measurements.rows - previous.rows));
    result.headers.set('X-Probe-Total-Snapshot-Reads', String(measurements.reads));
    result.headers.set('X-Probe-Total-Snapshot-Rows', String(measurements.rows));
    result.headers.set('X-Probe-Statements', String(measurements.statements - previous.statements));
    result.headers.set('X-Probe-Background', String(work.length));
    return result;
  }
};
