import { expect, test } from 'bun:test';
import { disposeSync, getLogger, withContext, type LogRecord } from '@logtape/logtape';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureApplicationLogging } from '../src/infrastructure/logging';
import { configureDesktopLogging } from '../src/hosts/desktop/logging';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import { createSources } from '../src/core/sources';
import { createLibrary } from '../src/core/library';
import { createManagementApi } from '../src/transport/http';
import { ApiError, createApi } from '../src/web/api';
import { observeAudio, observeFetch } from '../src/infrastructure/io-diagnostics';

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
    close = await configureDesktopLogging(directory);
    const logger = getLogger(['musicfs', 'background']);
    logger.debug('Routine activity');
    logger.error('Background step failed', { operationId: 'fixture-operation' });
    close(); close = undefined;
    const lines = (await Bun.file(join(directory, 'logs/musicfs.log')).text()).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'ERROR', message: 'Background step failed', properties: { operationId: 'fixture-operation' } });
  } finally { close?.(); await rm(directory, { recursive: true, force: true }); }
});
