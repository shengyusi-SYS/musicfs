/** Bounded direct-media consumer probe; no rclone cache, platform or account traffic. */
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { createReadCacheFixture } from './helpers/read-cache-fixture';

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { serve: { type: 'boolean' } } });
const fixture = await createReadCacheFixture();
if (values.serve) {
  await Bun.write('.musicfs/read-cache-fixture-runtime.json', JSON.stringify({ origin: fixture.server.url.href, url: fixture.url }));
  console.log(JSON.stringify({ ready: true, origin: fixture.server.url.href }));
  const stop = async () => { await fixture.close(); process.exit(0); }; process.on('SIGTERM', stop); process.on('SIGINT', stop);
} else try {
  const report: unknown[] = [];
  for (let pass = 0; pass < 2; pass++) {
    fixture.reset(); const started = performance.now();
    const child = Bun.spawn(['ffprobe', '-v', 'error', '-headers', 'Authorization: Basic ' + btoa('reader:fixture') + '\r\n',
      '-show_entries', 'format=duration:format_tags=title,artist,album', '-of', 'json', fixture.url], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, err); const parsed = JSON.parse(out) as { format: { duration: string; tags: { title: string } } };
    assert.equal(parsed.format.tags.title, 'Cache fixture title'); assert(Number(parsed.format.duration) > 119);
    await Bun.sleep(50); report.push({ operation: pass === 0 ? 'cold-ffprobe' : 'warm-ffprobe', milliseconds: Math.round(performance.now() - started), ...fixture.snapshot() });
  }
  // The exact same source range is repeated by a client without a byte cache.
  const headers = { Authorization: 'Basic ' + btoa('reader:fixture'), Range: `bytes=${fixture.content.size - 4096}-${fixture.content.size - 1}` };
  for (let pass = 0; pass < 2; pass++) {
    fixture.reset(); const response = await fetch(fixture.url, { headers }); assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 4096);
    report.push({ operation: pass === 0 ? 'tail-first' : 'tail-repeat', ...fixture.snapshot() });
  }
  const evidence = { scope: 'actual local FFprobe consumer + production Library/DAV/SQLite/audio-tags + valid synthetic MP3 HTTP source; no platform', report };
  console.log(JSON.stringify(evidence)); await Bun.write('.musicfs/dav-read-pattern-result.json', JSON.stringify(evidence, null, 2) + '\n');
} finally { await fixture.close(); }
