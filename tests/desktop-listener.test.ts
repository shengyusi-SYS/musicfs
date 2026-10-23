import { expect, test } from 'bun:test';
import { createDesktopListener } from '../src/hosts/desktop/listener';

const defaults = { managementAccess: 'local', managementPort: 0, davAccess: 'local', davPort: 0 } as const;

test('management and WebDAV use separate ports and do not serve each other', async () => {
  const listener = createDesktopListener({ fetch: () => new Response('owner route') });
  try {
    const address = listener.listen(defaults);
    const wrongPort = await fetch(address.origin + '/dav/');
    expect(wrongPort.status).toBe(404); await wrongPort.body?.cancel();
    expect(address.davPort).not.toBe(address.managementPort);
    expect(await (await fetch(address.davOrigin + '/dav/')).text()).toBe('owner route');
    const management = await fetch(address.davOrigin + '/api/status');
    expect(management.status).toBe(404); await management.body?.cancel();
  } finally { await listener.close(); }
});

test('changing DAV scope preserves the management endpoint and lets an existing response finish', async () => {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const encoder = new TextEncoder();
  const listener = createDesktopListener({ fetch(request) {
    if (new URL(request.url).pathname === '/configure') return Response.json(listener.reconfigure({ ...defaults, davAccess: 'lan' }));
    if (new URL(request.url).pathname !== '/dav/playing') return new Response('new connection');
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(encoder.encode('first-')); await released;
      controller.enqueue(encoder.encode('last')); controller.close();
    } }));
  } });
  try {
    const initial = listener.listen(defaults);
    const response = await fetch(initial.davOrigin + '/dav/playing', { keepalive: false });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first-');
    const changed = await fetch(initial.origin + '/configure', { method: 'POST', keepalive: false });
    expect(await changed.json()).toEqual({ ...initial, davAccess: 'lan' });
    expect(await (await fetch(initial.origin, { keepalive: false })).text()).toBe('new connection');
    release();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('last');
    expect((await reader.read()).done).toBe(true);
    expect(listener.reconfigure(defaults)).toEqual(initial);
  } finally { release(); await listener.close(); }
});

test('each port changes independently and an occupied port leaves both endpoints usable', async () => {
  const listener = createDesktopListener({ fetch: () => new Response('musicfs') });
  const blocker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('occupied') });
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null) });
  const nextPort = reservation.port!; await reservation.stop(true);
  try {
    const first = listener.listen(defaults);
    const next = listener.reconfigure({ ...defaults, managementPort: nextPort });
    expect(next.managementPort).toBe(nextPort); expect(next.davOrigin).toBe(first.davOrigin);
    expect(await (await fetch(next.origin)).text()).toBe('musicfs');
    expect(await (await fetch(first.davOrigin + '/dav/')).text()).toBe('musicfs');
    expect(() => listener.reconfigure({ ...next, davPort: blocker.port! })).toThrow();
    expect(listener.current()).toEqual(next);
    // If a later management change fails, an earlier DAV change is rolled back as well.
    const another = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null) });
    const davPort = another.port!; await another.stop(true);
    expect(() => listener.reconfigure({ ...next, managementPort: blocker.port!, davPort })).toThrow();
    expect(listener.current()).toEqual(next);
    const changed = listener.reconfigure({ ...next, davPort });
    expect(changed.origin).toBe(next.origin); expect(changed.davPort).toBe(davPort);
    expect(await (await fetch(changed.davOrigin + '/dav/')).text()).toBe('musicfs');
  } finally { await blocker.stop(true); await listener.close(); }
});
