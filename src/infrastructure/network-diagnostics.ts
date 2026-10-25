/** Read-only descriptions: never resolve DNS, choose a proxy, or alter a request. */
export type ProxyEnvironment = Readonly<Record<string, string | undefined>>;
type Endpoint = { protocol: string; host: string; port: number };

function endpoint(value: unknown): Endpoint | undefined {
  if (!(typeof value === 'string' || value instanceof URL)) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    return { protocol: url.protocol.slice(0, -1), host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
  } catch { return; }
}

/** Keep both casings: the runtime, not the logger, applies precedence and NO_PROXY. */
export function proxyEnvironmentFields(environment: ProxyEnvironment) {
  const proxies: Record<string, Endpoint | { invalidHttpProxy: true }> = {};
  for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    const value = environment[name];
    if (value) proxies[name] = endpoint(value) ?? { invalidHttpProxy: true };
  }
  return { proxies, noProxyConfigured: !!(environment.no_proxy || environment.NO_PROXY) };
}

function header(input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  return new Headers(headers).get(name);
}

export function requestNetworkFields(input: RequestInfo | URL, init?: RequestInit, environment?: ProxyEnvironment) {
  const target = endpoint(input instanceof Request ? input.url : input);
  const range = header(input, init, 'Range');
  const runtimeOptions = init as (RequestInit & { proxy?: unknown; unix?: unknown; session?: unknown }) | undefined;
  const proxy = runtimeOptions?.proxy;
  const explicit = proxy && typeof proxy === 'object' && 'url' in proxy ? endpoint(proxy.url) : endpoint(proxy);
  const proxyMode = runtimeOptions?.unix ? 'unix' : proxy === false ? 'disabled' : explicit ? 'explicit'
    : runtimeOptions?.session ? 'session' : environment ? 'environment' : 'platform';
  return { upstreamRequestId: crypto.randomUUID(),
    ...(target ? { targetProtocol: target.protocol, targetHost: target.host, targetPort: target.port } : {}),
    ...(range && range.length <= 192 && /^bytes=\d*-\d*(?:,\s*\d*-\d*)*$/.test(range) ? { requestRange: range } : {}),
    proxyMode, ...(explicit ? { proxyEndpoint: explicit } : {}),
    ...(proxy && typeof proxy === 'object' && 'respectNoProxy' in proxy && typeof proxy.respectNoProxy === 'boolean'
      ? { respectNoProxy: proxy.respectNoProxy } : {}),
    ...(environment ? { proxyEnvironment: proxyEnvironmentFields(environment) } : {}) };
}

export function responseNetworkFields(response: Response) {
  const target = endpoint(response.url);
  const length = response.headers.get('content-length');
  const range = response.headers.get('content-range');
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim();
  const retry = response.headers.get('retry-after');
  const seconds = retry ? /^\d+$/.test(retry) ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000) : NaN;
  return { redirected: response.redirected,
    ...(target ? { responseProtocol: target.protocol, responseHost: target.host, responsePort: target.port } : {}),
    ...(length && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? { upstreamContentLength: Number(length) } : {}),
    ...(range && range.length <= 96 && /^bytes (?:\d+-\d+|\*)\/(?:\d+|\*)$/.test(range) ? { upstreamContentRange: range } : {}),
    ...(mediaType && mediaType.length <= 100 && /^[\w.+-]+\/[\w.+-]+$/.test(mediaType) ? { upstreamMediaType: mediaType } : {}),
    ...(Number.isFinite(seconds) && seconds >= 0 ? { retryAfterSeconds: seconds } : {}) };
}

export function connectionFailure(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return 'request';
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (['ENOTFOUND', 'EAI_AGAIN', 'DNS_ERROR'].includes(code)) return 'dns';
  if (code.startsWith('ERR_PROXY_')) return 'proxy';
  if (/^(?:CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_VERIFY_)/.test(code)) return 'tls';
  if (['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return 'connect';
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code)) return 'timeout';
  if (['ECONNRESET', 'EPIPE'].includes(code)) return 'reset';
  if (depth < 2) {
    const children = [error.cause, ...(error instanceof AggregateError ? error.errors.slice(0, 4) : [])];
    for (const child of children) {
      const result = connectionFailure(child, depth + 1);
      if (result !== 'request') return result;
    }
  }
  return 'request';
}
