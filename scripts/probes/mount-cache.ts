import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { libraryFixture } from '../../tests/helpers/library-fixture';
import { createDav } from '../../src/transport/dav';
import { createMountManager } from '../../src/hosts/desktop/mounts';
import type { SourcePlugin } from '@musicfs/plugin-api';
// Opt-in native FUSE probe: four thousand offline entries, one cache-expiry boundary, no platform calls.
let mediaCalls = 0, propfinds = 0, count = 4000;
const source: SourcePlugin = {
  configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, value) => ({ ok: true, value }),
  roots: async () => ({ ok: true, value: { items: [{ sourceId: 'root', name: '音乐', directoryRef: 'root' }] } }),
  list: async () => ({ ok: true, value: { items: Array.from({ length: count }, (_, index) => ({
    kind: 'file' as const, entryId: String(index), name: `${index.toString().padStart(4, '0')}.mp3`,
    fileRef: JSON.stringify({ version: 4, descriptorKey: 'tag-seed:' + 'a'.repeat(64), generation: 'fixture-generation', modifiedAt: '2026-10-21T00:00:00.000Z',
      source: { version: 1, id: String(index), type: 'mp3', size: 8, md5: 'b'.repeat(32), level: 'standard' } }),
    info: { contentId: 'netease-reserved-v1:fixture-generation:' + index, size: 1_048_584, mediaType: 'audio/mpeg' }
  })) } }),
  stat: async () => { mediaCalls++; throw new Error('Enumeration must use published attributes'); },
  open: async () => { mediaCalls++; throw new Error('Enumeration must not read audio'); }
};
const f = await libraryFixture(source);
const scratch = await mkdtemp(join(tmpdir(), 'musicfs-reentry-'));
await f.library.refresh(f.id, undefined, new AbortController().signal);
await f.library.refresh(f.id, 'root', new AbortController().signal);
let snapshotReads = 0;
const readSnapshot = f.store.snapshot;
f.store.snapshot = (...args) => { snapshotReads++; return readSnapshot(...args); };
const dav = createDav(f.library.files, { username: 'reader', password: 'fixture' });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (request.method === 'PROPFIND') propfinds++;
  return dav.fetch(request);
} });
const manager = await createMountManager({ directory: join(scratch, 'mounts'), binary: resolve('dist/tools/rclone-v1.75.2-linux-amd64/rclone'),
  localConnection: () => ({ url: new URL('/dav/', server.url).href, username: 'reader', password: 'fixture' }) });
try {
  const result = await manager.mount({ mountPoint: join(scratch, 'drive'), source: { kind: 'local' } });
  assert.equal(result.state, 'mounted', JSON.stringify(result.error));
  const path = join(result.mountPoint, '实例 & #', '音乐');
  const enter = async (expected = 4000) => { const before = { propfinds, snapshotReads, started: performance.now() }; const files = await readdir(path); assert.equal(files.length, expected);
    return { milliseconds: Math.round((performance.now() - before.started) * 10) / 10, propfinds: propfinds - before.propfinds, snapshotReads: snapshotReads - before.snapshotReads }; };
  const first = await enter(), immediate = await enter();
  await Bun.sleep(6_100);
  const afterSixSeconds = await enter();
  await manager.configureCache(result.id, { directoryCacheSeconds: 0 });
  await enter(); count = 4001;
  await f.library.refresh(f.id, 'root', new AbortController().signal);
  const beforeManualRefresh = await enter();
  await manager.refresh(result.id);
  const afterManualRefresh = await enter(4001);
  assert.equal(beforeManualRefresh.propfinds, 0);
  assert(afterManualRefresh.propfinds > 0);
  const evidence = { runtime: 'actual WSL FUSE + production mount manager/rclone v1.75.2 + Library/DAV/SQLite', files: 4000,
    first, immediate, afterSixSeconds, beforeManualRefresh, afterManualRefresh, mediaCalls };
  console.log(JSON.stringify(evidence));
  await Bun.write(resolve('.musicfs/cache-reentry-result.json'), JSON.stringify(evidence, null, 2) + '\n');
  assert.equal(mediaCalls, 0);
  assert.equal(afterSixSeconds.propfinds, 0, 'Short revisits must reuse the mounted directory instead of refetching all 4000 entries');
} finally { await manager.close(); await server.stop(true); f.close(); await rm(scratch, { recursive: true, force: true }); }
