import type { D1Database } from '@cloudflare/workers-types';
import type { Context, Json, SourcePlugin } from '@musicfs/plugin-api';
import { open, prepare, type ReadRange, type TaggedPlan } from '../../packages/audio-tags/src';
import { createD1Store } from '../../src/infrastructure/persistence/d1';
import { createWorkerRegistry } from '../../src/hosts/worker/plugins';
import { createSources } from '../../src/core/sources';
import { createLibrary } from '../../src/core/library';
import { createDav } from '../../src/transport/dav';
import { createExtensions } from '../../src/core/extensions';
import { createManagementApi } from '../../src/transport/http';
import qq from 'musicfs-qq-artifact';
import netease from 'musicfs-netease-artifact';

let prepares = 0; let cacheReads = 0;
async function saved(ctx: Context): Promise<TaggedPlan> {
  cacheReads++;
  const plan = await ctx.cache!.get('tag-plan');
  if (!plan) throw new Error('The published plan must already exist in D1');
  return plan as unknown as TaggedPlan;
}
function fixture(bytes: Uint8Array, cover: Uint8Array): SourcePlugin {
  const sourceInfo = { contentId: 'synthetic-m4a-v1', size: bytes.length, mediaType: 'audio/mp4' };
  const readRange: ReadRange = async (range, signal) => {
    signal.throwIfAborted();
    return { content: sourceInfo, servedRange: range, body: new Blob([bytes.slice(range.start, range.end + 1)]).stream() };
  };
  return {
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, value) => ({ ok: true, value }),
    roots: async () => ({ ok: true, value: { items: [{ sourceId: 'audio', directoryRef: 'audio', name: 'Audio' }] } }),
    async list(ctx) {
      let plan = await ctx.cache!.get('tag-plan') as unknown as TaggedPlan | undefined;
      if (!plan) {
        prepares++;
        plan = await prepare({ format: 'm4a', sourceInfo, readRange, signal: ctx.signal, tags: {
          title: 'Worker song', artists: ['Artist A', 'Artist B'], album: 'Fixture album', albumArtists: ['Album artist'], date: '2026-10-21',
          track: { number: 3, total: 12 }, disc: { number: 2, total: 2 }, cover: { mimeType: 'image/png', data: cover },
          lyrics: { original: '[00:00.00]Original\n[00:00.50]Second line', translation: '[00:00.00]Translation', romanization: '[00:00.00]Romanization' }
        } });
        await ctx.cache!.put('tag-plan', plan as unknown as Json);
      }
      return { ok: true, value: { items: [{ kind: 'file', entryId: 'tagged', name: 'Tagged.m4a', fileRef: 'tagged', info: plan.content }] } };
    },
    stat: async ctx => ({ ok: true, value: (await saved(ctx)).content }),
    async open(ctx, _file, request) {
      const plan = await saved(ctx);
      if (plan.content.contentId !== request.expectedContentId) throw new Error('Unexpected tagged representation');
      return { ok: true, value: await open(plan, readRange, request.range, ctx.signal) };
    }
  };
}
export default {
  fetch(request: Request, env: { DB: D1Database; SOURCE: string; COVER: string }) {
    if (new URL(request.url).pathname === '/__probe') return Response.json({ prepares, cacheReads });
    if (new URL(request.url).pathname === '/__examples') return Response.json({ qq: qq.configuration, netease: netease.configuration });
    const decode = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
    const store = createD1Store(env.DB);
    const sources = createSources(store, createWorkerRegistry(store, [{ id: 'org.musicfs.test.metadata', revision: 'a'.repeat(64), module: fixture(decode(env.SOURCE), decode(env.COVER)) }]));
    const library = createLibrary(sources, store); const extensions = createExtensions(store, async () => {});
    if (new URL(request.url).pathname.startsWith('/api/')) return createManagementApi({ host: 'worker', adminToken: 'fixture-admin', sources, library, extensions,
      remove: id => extensions.remove(id), maxPackageBytes: 1024, install: async () => { throw new Error('Installation is outside this probe'); } }).fetch(request);
    return createDav(library.files, { username: 'reader', password: 'fixture-password' }, {
      fixedLength: size => new FixedLengthStream(size) as unknown as TransformStream<Uint8Array, Uint8Array>
    }).fetch(request);
  }
};
