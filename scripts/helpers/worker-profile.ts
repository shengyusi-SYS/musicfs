import type { Miniflare } from 'miniflare';

type ProfileNode = { id: number; callFrame: { functionName: string; url: string; lineNumber: number } };
type Profile = { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number };

/** Local V8 sampling of the user isolate, not Cloudflare's billed CPU measurement. */
export async function profileWorker<T>(mf: Miniflare, output: string, run: () => Promise<T>) {
  const endpoint = await mf.getInspectorURL(); endpoint.protocol = 'http:'; endpoint.pathname = '/json/list';
  const targets = await (await fetch(endpoint)).json() as { id: string; webSocketDebuggerUrl: string }[];
  const target = targets.find(target => target.id === 'core:user:');
  if (!target) throw new Error('User Worker inspector target is missing');
  const ws = new WebSocket(target.webSocketDebuggerUrl); let nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
    const task = message.id === undefined ? undefined : pending.get(message.id);
    if (!task) return; pending.delete(message.id!); clearTimeout(task.timer);
    if (message.error) task.reject(new Error(JSON.stringify(message.error))); else task.resolve(message.result);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Inspector connection timed out')), 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inspector connection failed')); }, { once: true });
    });
    const command = <R = unknown>(method: string) => new Promise<R>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector command timed out: ' + method)); }, 5000);
      pending.set(id, { resolve: value => resolve(value as R), reject, timer }); ws.send(JSON.stringify({ id, method }));
    });
    await command('Profiler.enable'); await command('Profiler.start');
    const value = await run(); const { profile } = await command<{ profile: Profile }>('Profiler.stop');
    await Bun.write(output, JSON.stringify(profile));
    const times = new Map<number, number>();
    profile.samples.forEach((id, index) => times.set(id, (times.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0)));
    const top = profile.nodes.map(node => ({ function: node.callFrame.functionName || '(anonymous)',
      url: node.callFrame.url, line: node.callFrame.lineNumber + 1, sampledSelfMs: +((times.get(node.id) ?? 0) / 1000).toFixed(2) }))
      .filter(node => node.sampledSelfMs > 0).sort((a, b) => b.sampledSelfMs - a.sampledSelfMs).slice(0, 15);
    return { value, summary: { file: output, samples: profile.samples.length,
      samplingWindowMs: (profile.endTime - profile.startTime) / 1000, top, cloudCpuTested: false } };
  } finally { for (const task of pending.values()) clearTimeout(task.timer); ws.close(); }
}
