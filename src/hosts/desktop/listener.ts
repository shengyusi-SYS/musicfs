import { t } from './locale';
import type { DesktopNetworkSettings } from '../../contracts/desktop';

export type DesktopListenerAddress = DesktopNetworkSettings & { origin: string; davOrigin: string };
type Endpoint = { access: 'local' | 'lan'; port: number };
const isDav = (path: string) => path === '/dav' || path.startsWith('/dav/');
const loopback = (address: string | undefined) => address === '::1' || address?.startsWith('127.') || address?.startsWith('::ffff:127.');

/** Independently owns each socket; changing one entry leaves the other entry and playback untouched. */
export function createDesktopListener(options: { fetch: (request: Request) => Response | Promise<Response> }) {
  const draining = new Set<Promise<void>>();
  function retire(server: ReturnType<typeof Bun.serve>) {
    const completion = server.stop(false);
    draining.add(completion);
    void completion.then(() => { draining.delete(completion); }, () => { draining.delete(completion); });
  }
  function endpoint(kind: 'management' | 'dav') {
    let active: { server: ReturnType<typeof Bun.serve>; address: Endpoint } | undefined;
    function bind(settings: Endpoint) {
      const server = Bun.serve({ hostname: settings.access === 'lan' ? '0.0.0.0' : '127.0.0.1', port: settings.port, idleTimeout: 0,
        fetch(request, server) {
          if (!active) return new Response(null, { status: 503 });
          if (isDav(new URL(request.url).pathname) !== (kind === 'dav')) return new Response(null, { status: 404 });
          // Current policy also applies to new requests on draining / keep-alive sockets.
          if (!loopback(server.requestIP(request)?.address) && active.address.access !== 'lan') {
            return Response.json({ error: 'local_access_only', message: t("此入口仅允许在运行 MusicFS 的电脑上访问。") },
              { status: 403, headers: { 'Cache-Control': 'no-store' } });
          }
          return options.fetch(request);
        } });
      return { server, address: { ...settings, port: server.port! } };
    }
    return {
      current: () => active ? { ...active.address } : undefined,
      listen(settings: Endpoint, fallback: boolean) {
        try { active = bind(settings); }
        catch (error) {
          if (!fallback || !settings.port || !(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')) throw error;
          active = bind({ ...settings, port: 0 });
        }
      },
      reconfigure(settings: Endpoint) {
        if (!active) throw new Error('MusicFS listener is not running');
        const previous = active; const next = { ...settings, port: settings.port || previous.address.port };
        if (next.port === previous.address.port && next.access === previous.address.access) return;
        if (next.port !== previous.address.port) {
          active = bind(next); retire(previous.server);
        } else {
          retire(previous.server);
          try { active = bind(next); }
          catch (error) { active = bind(previous.address); throw error; }
        }
      },
      close() { if (active) { retire(active.server); active = undefined; } }
    };
  }
  const management = endpoint('management'); const dav = endpoint('dav');
  function current(): DesktopListenerAddress | undefined {
    const manager = management.current(); const reader = dav.current();
    return manager && reader ? { managementAccess: manager.access, managementPort: manager.port, davAccess: reader.access, davPort: reader.port,
      origin: `http://127.0.0.1:${manager.port}`, davOrigin: `http://127.0.0.1:${reader.port}` } : undefined;
  }
  return {
    current,
    listen(settings: DesktopNetworkSettings, options: { fallback?: boolean } = {}): DesktopListenerAddress {
      if (current()) throw new Error('MusicFS listener is already running');
      try {
        // Preserve the old playback port when upgrading from a shared listener.
        dav.listen({ access: settings.davAccess, port: settings.davPort }, !!options.fallback);
        management.listen({ access: settings.managementAccess, port: settings.managementPort }, !!options.fallback);
      } catch (error) { management.close(); dav.close(); throw error; }
      return current()!;
    },
    reconfigure(settings: DesktopNetworkSettings): DesktopListenerAddress {
      const previous = current();
      if (!previous) throw new Error('MusicFS listeners are not running');
      try {
        dav.reconfigure({ access: settings.davAccess, port: settings.davPort });
        management.reconfigure({ access: settings.managementAccess, port: settings.managementPort });
      } catch (error) {
        dav.reconfigure({ access: previous.davAccess, port: previous.davPort });
        management.reconfigure({ access: previous.managementAccess, port: previous.managementPort });
        throw error;
      }
      return current()!;
    },
    async close() { management.close(); dav.close(); await Promise.all(draining); }
  };
}
