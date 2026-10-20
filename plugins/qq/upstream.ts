import type { ServerlessEnv } from '@yakult-green-tea/qq-music-api/serverless';
import {
  axios, CHECK_BUDGET_MS, capabilitiesFor, capturingQrSessionRepository, cookieHeader, createAuthHttpClient,
  createPtloginQrDriver, createQrLoginService, createSealedSessionResolver, failureResponse, loginStatus,
  mergeCookieHeaders, normalizeSetCookies, openQrState, qrCancel, qrCheck, qrCreate, qrDeviceRepositoryFor,
  qrKey, QrLoginServiceError, replayedRecord, replayQrSessionRepository, sealQrState, seedCookieJar,
  updateCookieJar, upstreamJson, type AuthHttpClient, type OperationHandler, type QrRouteService,
  type QrSessionRepository, type SealedQrPayloadV1
} from './generated-upstream.mjs';

export interface QqRequestContext { fetch: typeof fetch; signal: AbortSignal }
export type QqRequestHandler = (request: Request, env?: ServerlessEnv, context?: QqRequestContext) => Promise<Response>;
const handlers: Readonly<Record<string, OperationHandler>> = {
  '/login/qr/key': qrKey, '/login/qr/create': qrCreate, '/login/qr/check': qrCheck,
  '/login/qr/cancel': qrCancel, '/login/status': loginStatus
};

/** Keep SDK Cookie/redirect handling; bind only its installed Axios Fetch transport to this invocation. */
function authHttp(fetcher: typeof fetch, initialCookies = ''): AuthHttpClient {
  const transport = axios.create({ adapter: 'fetch', timeout: 10_000, maxRedirects: 0,
    // workerd rejects Axios's default `cache: default`; login requests never need an HTTP cache.
    fetchOptions: { cache: 'no-store' }, env: { fetch: fetcher } });
  // The SDK's Axios client has no initialCookies option. Restore the sealed web-login jar with
  // the SDK's own helpers, including cookie replacement/deletion on each redirect response.
  const restored = new Map<string, string>();
  seedCookieJar(restored, initialCookies);
  if (initialCookies) {
    transport.interceptors.request.use(config => {
      config.headers.set('Cookie', mergeCookieHeaders(cookieHeader(restored), String(config.headers.get('Cookie') ?? '')));
      return config;
    });
    transport.interceptors.response.use(response => {
      updateCookieJar(restored, normalizeSetCookies(response.headers['set-cookie']));
      return response;
    });
  }
  const http = createAuthHttpClient(transport);
  return { ...http, getCookieHeader: () => mergeCookieHeaders(cookieHeader(restored), http.getCookieHeader()) };
}

/** SDK login handlers and sealed-QR helpers, with request-scoped HTTP/driver ports instead of global Fetch. */
export const handleRequest: QqRequestHandler = async (request, env = {}, context) => {
  const signal = context?.signal ?? request.signal;
  signal.throwIfAborted();
  const hostFetch = context?.fetch ?? fetch;
  const fetcher = (async (input, init) => {
    signal.throwIfAborted();
    const upstreamSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return hostFetch(input, { ...init, signal: upstreamSignal ? AbortSignal.any([signal, upstreamSignal]) : signal });
  }) as typeof fetch;
  const url = new URL(request.url);
  const handler = handlers[url.pathname];
  if (!handler) return upstreamJson({ error: 'Unknown QQ authentication operation' }, 404);
  const secrets = { current: env.QQ_SESSION_SECRET ?? '', ...(env.QQ_SESSION_SECRET_PREVIOUS ? { previous: env.QQ_SESSION_SECRET_PREVIOUS } : {}) };
  const capabilities = capabilitiesFor({}, env);
  const assemble = async (payload?: SealedQrPayloadV1, repository?: QrSessionRepository) => {
    const { repository: deviceRepository } = await qrDeviceRepositoryFor(secrets, payload?.device);
    signal.throwIfAborted();
    let sessionHttp: AuthHttpClient | undefined;
    const service = createQrLoginService({
      http: authHttp(fetcher), createSessionHttp: () => sessionHttp = authHttp(fetcher, payload?.cookies),
      deviceRepository, sessionResolver: createSealedSessionResolver({ secrets }), capabilities,
      qrSessionRepository: repository ?? replayQrSessionRepository([]),
      drivers: { qq: createPtloginQrDriver({ fetch: fetcher }) }, checkBudgetMs: CHECK_BUDGET_MS
    });
    return { service, deviceRepository, cookies: () => sessionHttp?.getCookieHeader() ?? '' };
  };
  let service: ReturnType<typeof assemble> | undefined;
  const getService = async () => (await (service ??= assemble())).service;
  const qr: QrRouteService = {
    async createSession(channel) {
      const capture = capturingQrSessionRepository();
      const assembled = await assemble(undefined, capture.repository);
      const key = await assembled.service.createSession(channel);
      await assembled.service.createQr(key);
      const record = capture.latest().find(session => session.key === key);
      if (!record?.identifier) throw new Error('QR session has no upstream QR after createQr()');
      const device = assembled.deviceRepository.load();
      if (!device) throw new Error('QR session has no device');
      return sealQrState({ channel: record.channel, createdAt: record.createdAt, expiresAt: record.expiresAt,
        identifier: record.identifier, cookies: assembled.cookies(), device: {
          ...(device.qimei === undefined ? {} : { qimei: device.qimei }),
          ...(device.qimei36 === undefined ? {} : { qimei36: device.qimei36 }),
          ...(device.qimeiSavedAt === undefined ? {} : { qimeiSavedAt: device.qimeiSavedAt }),
          ...(device.sessionUid === undefined ? {} : { sessionUid: device.sessionUid }),
          ...(device.sessionSid === undefined ? {} : { sessionSid: device.sessionSid }),
          ...(device.sessionVkey === undefined ? {} : { sessionVkey: device.sessionVkey })
        }, ...(record.channel === 'qq' && record.imageUrl ? { image: record.imageUrl } : {}) }, secrets.current);
    },
    async createQr(key) {
      const payload = await openQrState(key, secrets, Date.now());
      if (!payload) throw new QrLoginServiceError('QR session not found or expired', 404);
      const { service } = await assemble(payload, replayQrSessionRepository([replayedRecord(key, payload, 'created')]));
      return service.createQr(key);
    },
    async checkQr(key) {
      const payload = await openQrState(key, secrets, Date.now());
      const { service } = await assemble(payload ?? undefined, replayQrSessionRepository(payload ? [replayedRecord(key, payload, 'waiting')] : []));
      return service.checkQr(key, CHECK_BUDGET_MS);
    },
    async cancelSession(key) { (await getService()).cancelSession(key); }
  };
  try {
    const query = (name: string) => url.searchParams.get(name) ?? undefined;
    const result = await handler({ runtime: 'serverless', method: request.method, body: () => request.json(),
      query, queryRaw: query, params: {}, token: request.headers.get('x-qq-session') ?? undefined,
      sessionConfigured: Boolean(env.QQ_SESSION_SECRET), service: getService, qr, capabilities });
    signal.throwIfAborted();
    return upstreamJson(result.body, result.status, result.headers);
  } catch (error) {
    signal.throwIfAborted();
    return failureResponse(error);
  }
};
