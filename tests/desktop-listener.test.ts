import { expect, test } from 'bun:test';
import { createDesktopListener } from '../src/hosts/desktop/listener';

test('changing LAN scope keeps the port and lets an existing response finish', async () => {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const encoder = new TextEncoder();
  const listener = createDesktopListener({ fetch(request) {
    if (new URL(request.url).pathname === '/configure') return Response.json(listener.reconfigure({ managementAccess: 'local', davAccess: 'lan', port: 0 }));
    if (new URL(request.url).pathname !== '/playing') return new Response('new connection');
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(encoder.encode('first-'));
      await released;
      controller.enqueue(encoder.encode('last')); controller.close();
    } }));
  } });
  try {
    const initial = listener.listen({ managementAccess: 'local', davAccess: 'local', port: 0 });
    const response = await fetch(`${initial.origin}/playing`, { keepalive: false });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first-');
    const changed = await fetch(`${initial.origin}/configure`, { method: 'POST', keepalive: false });
    expect(changed.status).toBe(200);
    const lan = await changed.json() as NonNullable<ReturnType<typeof listener.current>>;
    expect(lan).toEqual({ ...initial, davAccess: 'lan' });
    expect(await (await fetch(lan.origin, { keepalive: false })).text()).toBe('new connection');
    release();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('last');
    expect((await reader.read()).done).toBe(true);
    expect(listener.reconfigure({ managementAccess: 'local', davAccess: 'local', port: 0 })).toEqual(initial);
    expect(await (await fetch(initial.origin, { keepalive: false })).text()).toBe('new connection');
  } finally { release(); await listener.close(); }
});

test('port changes return the new origin and an occupied port preserves the current endpoint', async () => {
  const listener = createDesktopListener({ fetch: () => new Response('musicfs') });
  const blocker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('occupied') });
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null) });
  const nextPort = reservation.port!;
  await reservation.stop(true);
  try {
    const first = listener.listen({ managementAccess: 'local', davAccess: 'local', port: 0 });
    expect(() => listener.reconfigure({ managementAccess: 'local', davAccess: 'lan', port: blocker.port! })).toThrow();
    expect(listener.current()).toEqual(first);
    expect(await (await fetch(first.origin, { keepalive: false })).text()).toBe('musicfs');
    const next = listener.reconfigure({ managementAccess: 'local', davAccess: 'local', port: nextPort });
    expect(next.port).toBe(nextPort); expect(next.origin).not.toBe(first.origin);
    expect(await (await fetch(next.origin, { keepalive: false })).text()).toBe('musicfs');
  } finally { await blocker.stop(true); await listener.close(); }
});
