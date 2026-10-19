import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openSqlite } from '../../src/infrastructure/persistence/sqlite';
import { createDesktopPlugins } from '../../src/hosts/desktop/plugins';
import { createExtensions } from '../../src/core/extensions';
import { createSources } from '../../src/core/sources';
import { readPackage } from '../../src/infrastructure/archives';
import { createDesktopService } from '../../src/hosts/desktop/service';
import { requestReady } from '../../scripts/helpers/refresh-http';

const directory = process.env.MUSICFS_PROBE_DIRECTORY;
assert(directory, 'MUSICFS_PROBE_DIRECTORY is required for this developer probe');
await mkdir(directory, { recursive: true });
const store = openSqlite(join(directory, 'state.sqlite'));
try {
  const host = createDesktopPlugins(join(directory, 'plugins'), store);
  const extensions = createExtensions(store, host.prepare);
  const sources = createSources(store, host.registry);
  const signal = new AbortController().signal;
  const archivePath = process.env.MUSICFS_PROBE_ARCHIVE;
  if (archivePath) {
    const prepared = await readPackage(new Uint8Array(await Bun.file(archivePath).arrayBuffer()), 'desktop', signal);
    await extensions.install(prepared);
    const a = await sources.create(prepared.manifest.id, 'A', { label: '甲' }, signal);
    const b = await sources.create(prepared.manifest.id, 'B', { label: '乙' }, signal);
    assert(a.ok && b.ok);
    assert((await sources.configure(a.value.id, { label: '甲已修改' }, signal)).ok);
  }
  const instances = await sources.instances();
  assert.equal(instances.length, 2);
  const labels: string[] = [];
  const digests: string[] = [];
  for (const instance of instances) {
    const roots = await sources.roots(instance.id, signal); assert(roots.ok);
    assert(roots.value.items[0]); labels.push(roots.value.items[0].name);
    const stat = await sources.stat(instance.id, 'tone', signal); assert(stat.ok);
    const read = await sources.open(instance.id, 'tone', {
      expectedContentId: stat.value.contentId, range: { start: 0, end: 3 }
    }, signal);
    assert(read.ok);
    assert.equal(await new Response(read.value.body).text(), 'RIFF');
    const tail = await sources.open(instance.id, 'tone', {
      expectedContentId: stat.value.contentId, range: { start: stat.value.size - 16, end: stat.value.size - 1 }
    }, signal);
    assert(tail.ok);
    const bytes = await new Response(tail.value.body).arrayBuffer(); assert.equal(bytes.byteLength, 16);
    digests.push(new Bun.CryptoHasher('sha256').update(bytes).digest('hex'));
  }
  assert.deepEqual(labels, ['甲已修改', '乙']);
  const service = await createDesktopService({ directory, adminToken: 'fixture-compiled', dav: { username: 'reader', password: 'fixture-password' } });
  try {
    const listed = await service.app.request('http://probe/api/instances', { headers: { Authorization: 'Bearer fixture-compiled' } });
    assert.equal((await listed.json() as unknown[]).length, 2);
    const path = 'http://probe/dav/' + ['A', '甲已修改', '440 Hz.wav'].map(encodeURIComponent).join('/');
    const read = await requestReady(async (url, init) => service.app.request(url, init), path,
      { headers: { Authorization: 'Basic ' + Buffer.from('reader:fixture-password').toString('base64'), Range: 'bytes=0-3' } },
      { Authorization: 'Bearer fixture-compiled' });
    assert.equal(read.status, 206); assert.equal(await read.text(), 'RIFF');
  } finally { await service.close(); }
  console.log(JSON.stringify({ phase: archivePath ? 'install' : 'restart', instances: instances.length, labels, header: 'RIFF', tailDigests: digests, managementAndDav: true }));
} finally { store.close(); }
