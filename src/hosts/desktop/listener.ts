import type { DesktopNetworkSettings } from '../../contracts/desktop';

export type DesktopListenerAddress = { access: DesktopNetworkSettings['access']; port: number; origin: string };

/** Swaps the listening socket while existing playback responses finish on their original server. */
export function createDesktopListener(options: { fetch: (request: Request) => Response | Promise<Response> }) {
  let active: { server: ReturnType<typeof Bun.serve>; address: DesktopListenerAddress } | undefined;
  const draining = new Set<Promise<void>>();

  function bind(access: DesktopNetworkSettings['access'], port: number) {
    const server = Bun.serve({ hostname: access === 'lan' ? '0.0.0.0' : '127.0.0.1', port, fetch: options.fetch, idleTimeout: 0 });
    return { server, address: { access, port: server.port!, origin: `http://127.0.0.1:${server.port}` } };
  }
  function retire(server: ReturnType<typeof Bun.serve>) {
    // stop(false) releases the listening socket synchronously; its promise waits for active responses.
    const completion = server.stop(false);
    draining.add(completion);
    void completion.then(() => { draining.delete(completion); }, () => { draining.delete(completion); });
  }
  function listen(settings: DesktopNetworkSettings): DesktopListenerAddress {
    if (active) throw new Error('MusicFS listener is already running');
    active = bind(settings.access, settings.port);
    return { ...active.address };
  }
  function reconfigure(settings: DesktopNetworkSettings): DesktopListenerAddress {
    if (!active) return listen(settings);
    const previous = active;
    // Switching between automatic and fixed configuration need not move a working automatic port.
    const port = settings.port || previous.address.port;
    if (settings.access === previous.address.access && port === previous.address.port) return { ...previous.address };
    if (port !== previous.address.port) {
      // A failed port change leaves the original endpoint available.
      active = bind(settings.access, port);
      retire(previous.server);
    } else {
      retire(previous.server);
      try { active = bind(settings.access, port); }
      catch (error) {
        // A wider bind can collide with a listener on another interface. Restore the previous scope.
        active = bind(previous.address.access, previous.address.port);
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
