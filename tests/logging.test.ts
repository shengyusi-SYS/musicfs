import { expect, test } from 'bun:test';
import { disposeSync, getLogger, withContext, type LogRecord } from '@logtape/logtape';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureApplicationLogging } from '../src/infrastructure/logging';
import { configureDesktopLogging } from '../src/hosts/desktop/logging';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import { createSources } from '../src/core/sources';
import { createLibrary, PendingRefreshError, type FileView } from '../src/core/library';
import { createDav } from '../src/transport/dav';
import { createManagementApi } from '../src/transport/http';
import { ApiError, createApi } from '../src/web/api';
import { observeAudio, observeFetch, observeSources } from '../src/infrastructure/io-diagnostics';
import type { Sources } from '../src/core/sources';

test('DAV preparation failures remain diagnosable at the default log level', async () => {
  const records: LogRecord[] = [];
  configureApplicationLogging({ capture: record => { records.push(record); } });
  const view = { stat: async () => { throw new PendingRefreshError('fixture-refresh'); } } as unknown as FileView;
  try {
    const dav = createDav(view, { username: 'reader', password: 'fixture-password' });
    const response = await dav.request('/dav/private-song.mp3', { headers: {
      Authorization: 'Basic ' + btoa('reader:fixture-password'), Range: 'bytes=1024-2047'
    } });
    expect(response.status).toBe(503);
    expect(response.headers.get('X-MusicFS-Refresh')).toBe('fixture-refresh');
    expect(records).toHaveLength(1);
    expect(records[0]!.properties).toMatchObject({ requestId: response.headers.get('X-MusicFS-Request-ID'),
      status: 503, operationId: 'fixture-refresh', errorCode: 'refresh_pending', ioStage: 'stat', range: 'bytes=1024-2047' });
    expect(JSON.stringify(records)).not.toContain('private-song');
  } finally { disposeSync(); }
});

test('an unexpected HTTP failure can be matched to its log without exposing credentials or raw error text', async () => {
  const records: LogRecord[] = [];
  configureApplicationLogging({ capture: record => { records.push(record); } });
  const store = openSqlite(':memory:');
  const sources = createSources(store, { get: async () => { throw new Error('Unused'); }, isCurrent: async () => false });
  const library = createLibrary(sources, store);
  const secret = 'fixture-private-url-and-password';
  const api = createManagementApi({ host: 'desktop', adminToken: secret, sources, library,
    extensions: { list: async () => { throw new Error('Provider failed at https://user:' + secret + '@fixture/?token=' + secret); } },
    maxPackageBytes: 1024, install: async () => { throw new Error('Unused'); }, remove: async () => {} });
  try {
    const response = await api.request('/api/plugins?token=' + secret, { headers: { Authorization: 'Bearer ' + secret, Cookie: 'private=' + secret } });
    expect(response.status).toBe(500);
    const result = await response.json() as { requestId: string };
    expect(response.headers.get('X-MusicFS-Request-ID')).toBe(result.requestId);
    expect(records).toHaveLength(1);
    expect(records[0]!.properties).toMatchObject({ requestId: result.requestId, route: '/api/plugins', method: 'GET', status: 500, errorType: 'Error' });
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(records[0]!.properties.frames).not.toEqual([]);
    const fetcher = (async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ message: 'Operation failed' }, {
      status: 500, headers: { 'X-MusicFS-Request-ID': result.requestId }
    })) as typeof fetch;
    let failure: unknown;
    try { await createApi('', fetcher).status(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).requestId).toBe(result.requestId);
  } finally { store.close(); disposeSync(); }
});

test('upstream diagnostics retain request context, leave bytes untouched and bound repetitive records', async () => {
  const records: LogRecord[] = [];
  configureApplicationLogging({ capture: record => { records.push(record); } }, 'debug');
  const fetcher = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('audio-bytes', { status: 206 })) as typeof fetch;
  const observed = observeFetch(fetcher, 'source');
  try {
    await withContext({ requestId: 'fixture-request', instanceId: 'fixture-source' }, async () => {
      for (let i = 0; i < 25; i++) {
        const response = await observed('https://private-user:private-password@fixture.invalid/audio?token=private-token');
        expect(await response.text()).toBe('audio-bytes');
      }
    });
    const entries = records.filter(record => record.rawMessage === 'Upstream response ready');
    expect(entries).toHaveLength(20);
    expect(entries[0]!.properties).toMatchObject({ requestId: 'fixture-request', instanceId: 'fixture-source', status: 206 });
    expect(JSON.stringify(records)).not.toContain('private-');
    disposeSync();
    expect(records.some(record => record.properties.suppressed === 5)).toBe(true);
  } finally { disposeSync(); }
});

test('log levels change without replacing sinks or spending the IO quota while debug is disabled', () => {
  const records: LogRecord[] = [];
  const runtime = configureApplicationLogging({ capture: record => { records.push(record); } });
  const logger = getLogger(['musicfs', 'io', 'source']);
  try {
    for (let i = 0; i < 25; i++) logger.debug('Fixture request');
    runtime.setLevel('debug');
    logger.debug('Fixture request');
    expect(records).toHaveLength(1);
    runtime.setLevel('warning');
    logger.debug('Fixture request'); logger.warning('Fixture failure');
    expect(records).toHaveLength(2);
  } finally { disposeSync(); }
});

test('provider business faults are logged even when their HTTP transport succeeds', async () => {
  const records: LogRecord[] = [];
  configureApplicationLogging({ capture: record => { records.push(record); } });
  const source = observeSources({ roots: async () => ({ ok: false, error: {
    kind: 'rate_limited', message: 'fixture-private-provider-message', retryAfterSeconds: 60
  } }) } as unknown as Sources);
  try {
    const result = await source.roots('fixture-instance', new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]!.properties).toMatchObject({ instanceId: 'fixture-instance', sourceOperation: 'roots', sourceFaultKind: 'rate_limited', retryAfterSeconds: 60 });
    expect(JSON.stringify(records)).not.toContain('fixture-private-provider-message');
  } finally { disposeSync(); }
});

test('deadline expiry is a warning while an ordinary abort remains a debug event', async () => {
  const records: LogRecord[] = [];
  configureApplicationLogging({ capture: record => { records.push(record); } });
  const observed = observeFetch((async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    throw init?.signal?.reason;
  }) as typeof fetch, 'rclone');
  try {
    const timeout = AbortSignal.abort(new DOMException('fixture-deadline', 'TimeoutError'));
    await expect(observed('http://fixture.invalid', { signal: timeout })).rejects.toThrow();
    await expect(observed('http://fixture.invalid', { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(records).toHaveLength(1);
    expect(records[0]!.properties).toMatchObject({ timedOut: true, errorType: 'TimeoutError' });
  } finally { disposeSync(); }
});

test('stream diagnostics preserve pull and cancellation and record a midstream failure once', async () => {
  const records: LogRecord[] = []; let pulls = 0; let cancelled = false;
  configureApplicationLogging({ capture: record => { records.push(record); } }, 'debug');
  try {
    const signal = new AbortController().signal;
    const source = new ReadableStream<Uint8Array>({ pull(controller) {
      if (++pulls === 1) controller.enqueue(new Uint8Array([1, 2]));
      else controller.error(new Error('fixture-private-provider-url'));
    } }, { highWaterMark: 0 });
    const observed = observeAudio(source, { requestId: 'fixture-request', expectedBytes: 4, ranged: true }, signal);
    expect(pulls).toBe(0);
    await expect(new Response(observed).arrayBuffer()).rejects.toThrow('fixture-private-provider-url');
    expect(records.filter(record => record.rawMessage === 'Audio stream failed')).toHaveLength(1);
    expect(records[0]!.properties).toMatchObject({ requestId: 'fixture-request', bytes: 2 });
    expect(JSON.stringify(records)).not.toContain('fixture-private-provider-url');
    const short = observeAudio(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([1])); controller.close();
    } }), { requestId: 'fixture-short', expectedBytes: 4, ranged: true, rangeStart: 10, rangeEnd: 13 }, signal);
    await new Response(short).arrayBuffer();
    expect(records.find(record => record.properties.requestId === 'fixture-short')!.properties).toMatchObject({
      failureKind: 'unexpected_eof', expectedBytes: 4, bytes: 1, rangeStart: 10, rangeEnd: 13, ioStage: 'body'
    });
    const idle = observeAudio(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }),
      { requestId: 'fixture-cancel', expectedBytes: 4, ranged: false }, signal);
    await idle.cancel();
    expect(cancelled).toBe(true);
    expect(records.filter(record => record.rawMessage === 'Audio stream cancelled')).toHaveLength(1);
  } finally { disposeSync(); }
});

test('desktop logging writes structured failures to the data directory and suppresses routine debug output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-logging-'));
  let close: (() => void) | undefined;
  try {
    const logging = await configureDesktopLogging(directory);
    close = () => logging.close();
    const logger = getLogger(['musicfs', 'background']);
    logger.debug('Routine activity');
    logger.error('Background step failed', { operationId: 'fixture-operation' });
    close(); close = undefined;
    const lines = (await Bun.file(join(directory, 'logs/musicfs.log')).text()).trim().split('\n');
    const records = lines.map(line => JSON.parse(line));
    expect(records.find(record => record.message === 'Application logging started')).toMatchObject({ properties: { level: 'info' } });
    expect(records.find(record => record.level === 'ERROR')).toMatchObject({ message: 'Background step failed', properties: { operationId: 'fixture-operation' } });
    expect(records.some(record => record.message === 'Routine activity')).toBe(false);
  } finally { close?.(); await rm(directory, { recursive: true, force: true }); }
});
