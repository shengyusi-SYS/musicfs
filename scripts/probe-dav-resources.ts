import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import type { Description, ViewEntry } from '../src/core/library';
import { propfindResponse, type PropfindRequest } from '../src/transport/dav/xml';

// Isolate XML work from sources and persistence. These are local process
// measurements, never Cloudflare CPU, quota, or peak-memory acceptance.
const { values } = parseArgs({ args: Bun.argv.slice(2), options: { output: { type: 'string' } } });
const parent: Description = { kind: 'directory', path: '/fixture', name: 'Fixture', etag: 'directory-v1', modifiedAt: '2026-10-20T00:00:00.000Z' };
const metadata: PropfindRequest = { mode: 'allprop', properties: [] };
const names: PropfindRequest = { mode: 'prop', properties: ['displayname', 'resourcetype', 'getlastmodified'].map(name => ({ namespace: 'DAV:', name })) };
const results: Record<string, unknown>[] = [];
for (const count of [1, 100, 4657]) {
  const descriptions = new Map<ViewEntry, Description>();
  const entries = Array.from({ length: count }, (_, index) => {
    const entry: ViewEntry = { kind: 'file', path: `/fixture/${index}.flac`, name: `曲目 ${index} & 版本.flac`, modifiedAt: parent.modifiedAt };
    descriptions.set(entry, { ...entry, kind: 'file', etag: `known-content-${index}`, handle: {
      stamp: { id: 'fixture', pluginId: 'org.musicfs.fixture', epoch: 1, pluginRevision: 'fixture', pluginGeneration: 1 },
      fileRef: `file-${index}`, content: { contentId: `known-content-${index}`, size: 25_808_273, mediaType: 'audio/flac' }
    } });
    return entry;
  });
  for (const selection of [names, metadata]) {
    const memory = process.memoryUsage(); const cpu = process.cpuUsage(); const start = performance.now();
    let lookups = 0;
    const xml = await propfindResponse(parent, entries, selection, async entry => { lookups++; return descriptions.get(entry)!; }, () => 500);
    const elapsedMs = performance.now() - start; const used = process.cpuUsage(cpu); const after = process.memoryUsage();
    assert.equal((xml.match(/<D:response>/g) ?? []).length, count + 1);
    assert(xml.includes('&amp;')); assert.equal(lookups, selection === metadata ? count : 0);
    results.push({ entries: count, selection: selection.mode === 'allprop' ? 'allprop' : 'names', bytes: Buffer.byteLength(xml),
      elapsedMs: +elapsedMs.toFixed(2), processCpuMs: +((used.user + used.system) / 1000).toFixed(2),
      heapDeltaBytes: after.heapUsed - memory.heapUsed, rssDeltaBytes: after.rss - memory.rss,
      networkRequests: 0, databaseQueries: 0, metadataLookups: lookups });
  }
}
const report = { measured: 'local Bun process; isolated XML with already prepared metadata',
  cloudCpuTested: false, peakMemoryTested: false, results };
if (values.output) await Bun.write(values.output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
