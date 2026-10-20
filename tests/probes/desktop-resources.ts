import { join } from 'node:path';
import { createDesktopService } from '../../src/hosts/desktop/service';

// Instrument only this disposable process. The client/upstream and their buffers
// live in the parent process, and no probe route enters product code.
const directory = process.argv[2]; if (!directory) throw new Error('Resource probe data directory is required');
const service = await createDesktopService({ directory, adminToken: 'resource-fixture-admin', dav: { username: 'reader', password: 'resource-fixture-reader' } });
let baseline = process.memoryUsage(); let peak = { ...baseline }; let cpu = process.cpuUsage(); let started = 0; let samples = 0;
let timer: ReturnType<typeof setInterval> | undefined;
function sample() {
  const memory = process.memoryUsage(); samples++;
  for (const key of ['rss', 'heapUsed', 'external', 'arrayBuffers'] as const) peak[key] = Math.max(peak[key], memory[key]);
}
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/__resource/') && request.headers.get('Authorization') === 'Bearer resource-fixture-admin') {
    if (path === '/__resource/start' && request.method === 'POST') {
      clearInterval(timer); baseline = process.memoryUsage(); peak = { ...baseline }; cpu = process.cpuUsage(); samples = 0; started = performance.now();
      timer = setInterval(sample, 20); return Response.json({ started: true });
    }
    if (path === '/__resource/end') {
      clearInterval(timer); timer = undefined; sample(); const used = process.cpuUsage(cpu);
      return Response.json({ baseline, after: process.memoryUsage(), sampledPeak: peak, samples, sampleIntervalMs: 20,
        elapsedMs: performance.now() - started, processCpuMs: (used.user + used.system) / 1000 });
    }
  }
  return service.app.fetch(request);
} });
await Bun.write(join(directory, 'ready.json'), JSON.stringify({ origin: server.url.origin }));
async function close() { clearInterval(timer); await server.stop(true); await service.close(); process.exit(0); }
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
