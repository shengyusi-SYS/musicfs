import type { DesktopNetworkSettings } from '../../contracts/desktop';

export type DesktopListenerAddress = DesktopNetworkSettings & { origin: string };

const acceptsLan = (settings: DesktopNetworkSettings) => settings.managementAccess === 'lan' || settings.davAccess === 'lan';
const loopback = (address: string | undefined) => address === '::1' || address?.startsWith('127.') || address?.startsWith('::ffff:127.');

/** Swaps the listening socket while existing playback responses finish on their original server. */
export function createDesktopListener(options: { fetch: (request: Request) => Response | Promise<Response> }) {
  let active: { server: ReturnType<typeof Bun.serve>; address: DesktopListenerAddress } | undefined;
  const draining = new Set<Promise<void>>();

  function bind(settings: DesktopNetworkSettings, port: number) {
    const server = Bun.serve({ hostname: acceptsLan(settings) ? '0.0.0.0' : '127.0.0.1', port, idleTimeout: 0,
      fetch(request, server) {
        if (!active) return new Response(null, { status: 503 });
        const path = new URL(request.url).pathname;
        const scope = path === '/dav' || path.startsWith('/dav/') ? 'davAccess' : 'managementAccess';
        // The socket peer is authoritative; Host and forwarding headers do not grant local access.
        // Consult the current policy even on a draining server or an existing keep-alive connection.
        if (!loopback(server.requestIP(request)?.address) && active.address[scope] !== 'lan') {
          return Response.json({ error: 'local_access_only', message: '此入口仅允许在运行 MusicFS 的电脑上访问。' },
            { status: 403, headers: { 'Cache-Control': 'no-store' } });
        }
        return options.fetch(request);
      } });
    return { server, address: { ...settings, port: server.port!, origin: `http://127.0.0.1:${server.port}` } };
  }
  function retire(server: ReturnType<typeof Bun.serve>) {
    // stop(false) releases the listening socket synchronously; its promise waits for active responses.
    const completion = server.stop(false);
    draining.add(completion);
    void completion.then(() => { draining.delete(completion); }, () => { draining.delete(completion); });
  }
  function listen(settings: DesktopNetworkSettings): DesktopListenerAddress {
    if (active) throw new Error('MusicFS listener is already running');
    active = bind(settings, settings.port);
    return { ...active.address };
  }
  function reconfigure(settings: DesktopNetworkSettings): DesktopListenerAddress {
    if (!active) return listen(settings);
    const previous = active;
    // Switching between automatic and fixed configuration need not move a working automatic port.
    const port = settings.port || previous.address.port;
    if (port === previous.address.port && acceptsLan(settings) === acceptsLan(previous.address)) {
      active.address = { ...settings, port, origin: previous.address.origin };
      return { ...active.address };
    }
    if (port !== previous.address.port) {
      // A failed port change leaves the original endpoint available.
      active = bind(settings, port);
      retire(previous.server);
    } else {
      retire(previous.server);
      try { active = bind(settings, port); }
      catch (error) {
        // A wider bind can collide with a listener on another interface. Restore the previous scope.
        active = bind(previous.address, previous.address.port);
        throw error;
      }
    }
    return { ...active.address };
  }
  return {
    listen, reconfigure,
    current: (): DesktopListenerAddress | undefined => active ? { ...active.address } : undefined,
    async close() {
      if (active) { retire(active.server); active = undefined; }
      await Promise.all(draining);
    },
  };
}
