import { expect, test } from 'bun:test';
import { configureApplicationLogging, errorFields } from '../src/infrastructure/logging';
import { observeFetch } from '../src/infrastructure/io-diagnostics';
import { disposeSync, withContext, type LogRecord } from '@logtape/logtape';

test('a failed source connection identifies its endpoint and nested socket failures without logging credentials', async () => {
  const records: LogRecord[] = [];
  configureApplicationLogging({ capture: record => { records.push(record); } });
  const refused = Object.assign(new Error('private-provider-url'), { code: 'ECONNREFUSED', address: '192.0.2.1', port: 443, syscall: 'connect', errno: -111 });
  const unreachable = Object.assign(new Error('private-network-message'), { code: 'ENETUNREACH', address: '2001:db8::1', port: 443 });
  const failure = new TypeError('private-password', { cause: new AggregateError([refused, unreachable], 'private-cause') });
  const observed = observeFetch((async () => { throw failure; }) as unknown as typeof fetch, 'source');
  try {
    await withContext({ requestId: 'fixture-dav', instanceId: 'fixture-source' }, async () => {
      await expect(observed('https://private-user:private-password@api.example.invalid:8443/audio?token=private-token', {
        method: 'POST', headers: { Range: 'bytes=10-19', Cookie: 'private-cookie' }, body: 'private-body'
      })).rejects.toBe(failure);
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.properties).toMatchObject({ requestId: 'fixture-dav', instanceId: 'fixture-source',
      targetHost: 'api.example.invalid', targetPort: 8443, targetProtocol: 'https', method: 'POST',
      requestRange: 'bytes=10-19', ioStage: 'headers', connectionFailure: 'connect', timedOut: false });
    expect(records[0]!.properties.upstreamRequestId).toBeString();
    expect(errorFields(failure)).toMatchObject({ cause: { errors: [
      { errorCode: 'ECONNREFUSED', address: '192.0.2.1', port: 443, syscall: 'connect', errno: -111 },
      { errorCode: 'ENETUNREACH', address: '2001:db8::1', port: 443 }
    ] } });
    expect(JSON.stringify(records)).not.toContain('private-');
  } finally { disposeSync(); }
});

test('response diagnostics preserve the original response and report range, size and redirect destination', async () => {
  const records: LogRecord[] = [];
  configureApplicationLogging({ capture: record => { records.push(record); } }, 'debug');
  const response = new Response('audio', { status: 206, headers: { 'Content-Length': '5',
    'Content-Range': 'bytes 10-14/99', 'Content-Type': 'audio/mpeg; private-secret=hidden' } });
  Object.defineProperties(response, { url: { value: 'https://cdn.example.invalid/file?private-token=hidden' }, redirected: { value: true } });
  const observed = observeFetch((async () => response) as unknown as typeof fetch, 'source');
  try {
    const result = await observed(new Request('https://api.example.invalid/audio', { headers: { Range: 'bytes=10-14' } }));
    expect(result).toBe(response);
    expect(result.bodyUsed).toBe(false);
    expect(await result.text()).toBe('audio');
    const start = records.find(record => record.rawMessage === 'Upstream request started')!;
    const end = records.find(record => record.rawMessage === 'Upstream response ready')!;
    expect(start.properties.upstreamRequestId).toBe(end.properties.upstreamRequestId);
    expect(end.properties).toMatchObject({ targetHost: 'api.example.invalid', requestRange: 'bytes=10-14',
      responseHost: 'cdn.example.invalid', redirected: true, upstreamContentLength: 5,
      upstreamContentRange: 'bytes 10-14/99', upstreamMediaType: 'audio/mpeg' });
    expect(JSON.stringify(records)).not.toContain('private-');
  } finally { disposeSync(); }
});

test('connection failure samples remain bounded per host and method, not per request or range', async () => {
  const records: LogRecord[] = [];
  configureApplicationLogging({ capture: record => { records.push(record); } });
  const observed = observeFetch((async () => { throw Object.assign(new TypeError('fixture'), { code: 'ECONNREFUSED' }); }) as unknown as typeof fetch, 'source');
  try {
    for (let i = 0; i < 25; i++) await observed('https://api.example.invalid', { method: 'POST', headers: { Range: `bytes=${i}-${i}` } }).catch(() => {});
    await observed('https://cdn.example.invalid').catch(() => {});
    const failures = records.filter(record => record.rawMessage === 'Upstream connection failed');
    expect(failures.filter(record => record.properties.targetHost === 'api.example.invalid')).toHaveLength(20);
    expect(failures.filter(record => record.properties.targetHost === 'cdn.example.invalid')).toHaveLength(1);
  } finally { disposeSync(); }
});

test('proxy diagnostics describe current environment and explicit options without changing routing or exposing secrets', async () => {
  const records: LogRecord[] = [];
  configureApplicationLogging({ capture: record => { records.push(record); } });
  const environment = { HTTPS_PROXY: 'http://private-user:private-password@proxy.example.invalid:3128/?private-token',
    NO_PROXY: 'localhost,private-internal-host' };
  let forwarded: RequestInit | undefined;
  const observed = observeFetch((async (_input: RequestInfo | URL, init?: RequestInit) => {
    forwarded = init; throw Object.assign(new Error('private-connection-message'), { code: 'ERR_PROXY_TUNNEL', status: 407 });
  }) as unknown as typeof fetch, 'source', environment);
  try {
    await observed('https://api.example.invalid').catch(() => {});
    expect(records[0]!.properties).toMatchObject({ proxyMode: 'environment', connectionFailure: 'proxy', upstreamStatus: 407,
      proxyEnvironment: { noProxyConfigured: true, proxies: { HTTPS_PROXY: { protocol: 'http', host: 'proxy.example.invalid', port: 3128 } } } });
    environment.HTTPS_PROXY = 'http://updated.example.invalid:8080';
    const init = { proxy: false } as RequestInit;
    await observed('https://api.example.invalid', init).catch(() => {});
    expect(forwarded).toBe(init);
    expect(records[1]!.properties).toMatchObject({ proxyMode: 'disabled',
      proxyEnvironment: { proxies: { HTTPS_PROXY: { host: 'updated.example.invalid', port: 8080 } } } });
    await observed('https://api.example.invalid', { proxy: { url: 'http://private-user:private-password@explicit.example.invalid:9999',
      headers: { 'Proxy-Authorization': 'private-token' }, respectNoProxy: false } } as RequestInit).catch(() => {});
    expect(records[2]!.properties).toMatchObject({ proxyMode: 'explicit', respectNoProxy: false,
      proxyEndpoint: { protocol: 'http', host: 'explicit.example.invalid', port: 9999 } });
    expect(JSON.stringify(records)).not.toContain('private-');
  } finally { disposeSync(); }
});
