import { resolve } from 'node:path';
import { Miniflare, Log, LogLevel } from 'miniflare';
const build = await Bun.build({ entrypoints: ['tests/probes/http-bridge.ts'], target: 'node', format: 'esm', external: ['cloudflare:node'],
  outdir: 'dist/p0', naming: 'http-bridge.mjs', define: { 'import.meta.url': JSON.stringify('file:///bundle/http-bridge.mjs') } });
if (!build.success) throw new AggregateError(build.logs, 'HTTP bridge probe failed to build');
const mf = new Miniflare({ modules: [{ type: 'ESModule', path: resolve('dist/p0/http-bridge.mjs') }],
  compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', 'enable_nodejs_http_server_modules'], log: new Log(LogLevel.ERROR) });
try {
  for (const mode of ['direct', 'node-stream', 'stream', 'flush', 'pipe-event']) {
    try {
      const response = await mf.dispatchFetch(`http://probe/${mode}`);
      const text = await response.text(); console.log(JSON.stringify({ mode, status: response.status, body: text }));
    } catch (error) { console.log(JSON.stringify({ mode, error: error instanceof Error ? error.message : 'failed' })); }
  }
} finally { await mf.dispose(); }
