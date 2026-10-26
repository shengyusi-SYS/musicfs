import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadResult } from '@musicfs/plugin-api';
import type { FileDescription, FileView } from '../src/core/library';
import { createDesktopReadCache } from '../src/hosts/desktop/read-cache';

test('shared byte cache upgrades the old retention once and preserves later custom choices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-read-cache-policy-'));
  const unused = async (): Promise<never> => { throw new Error('Retention migration must not start native caching'); };
  const create = () => createDesktopReadCache({ directory, controlDirectory: join(directory, 'control'),
    view: { list: unused, stat: unused, statMany: unused, open: unused },
    control: { call: unused, removeRemote: unused, close: unused }, current: () => true });
  await Bun.write(join(directory, 'settings.json'), JSON.stringify({ maxMiB: 64, maxAgeHours: 168 }));
  let cache = await create();
  try {
    expect((await cache.inspect()).settings).toEqual({ maxMiB: 64, maxAgeHours: 8760 });
    await cache.configure({ maxMiB: 64, maxAgeHours: 168 });
    await cache.close(); cache = await create();
    expect((await cache.inspect()).settings).toEqual({ maxMiB: 64, maxAgeHours: 168 });
  } finally { await cache.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an unused shared cache can be inspected and closed without activating or modifying rclone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-unused-read-cache-'));
  const unused = async (): Promise<never> => { throw new Error('Unused native capability was activated'); };
  const view: FileView = { list: unused, stat: unused, statMany: unused, open: unused };
  try {
    const cache = await createDesktopReadCache({ directory, controlDirectory: join(directory, 'control'), view,
      control: { call: unused, removeRemote: unused, close: unused }, current: () => true });
    expect(await cache.inspect()).toMatchObject({ state: 'inactive', files: null, settings: { maxMiB: 16384 } });
    await cache.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the App direct-read endpoint retains the original batch metadata path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-read-cache-bulk-'));
  let batches = 0;
  const description = (path: string) => ({ kind: 'directory' as const, path, name: path.slice(1), etag: path, modifiedAt: '2026-10-21T00:00:00.000Z' });
  const view: FileView = { stat: async entry => description(typeof entry === 'string' ? entry : entry.path),
    list: async () => ['/one', '/two'].map(path => description(path)),
    async statMany(items) { batches++; return new Map(items.map(item => [item, description(item.path)])); },
    open: async () => { throw new Error('Metadata enumeration must not open audio'); } };
  const unused = async (): Promise<never> => { throw new Error('Enumeration must not activate rclone'); };
  const cache = await createDesktopReadCache({ directory, controlDirectory: join(directory, 'control'), view,
    control: { call: unused, removeRemote: unused, close: unused }, current: () => true });
  try {
    const connection = cache.mountConnection;
    const response = await fetch(connection.url, { method: 'PROPFIND', headers: { Depth: '1',
      Authorization: `Basic ${btoa(`${connection.username}:${connection.password}`)}` } });
    expect(response.status).toBe(207); await response.text(); expect(batches).toBe(1);
  } finally { await cache.close(); await rm(directory, { recursive: true, force: true }); }
});

const bytes = new Uint8Array([1, 2, 3, 4]);
const file: FileDescription = { kind: 'file', path: '/song.mp3', name: 'song.mp3', etag: 'song', modifiedAt: '2026-10-22T00:00:00.000Z',
  handle: { stamp: { id: 'source', epoch: 1, pluginId: 'fixture', pluginRevision: '1', pluginGeneration: 1 }, fileRef: 'song',
    content: { contentId: 'song', size: bytes.length, mediaType: 'audio/mpeg' } } };
async function disabledCache(open: FileView['open']) {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-disabled-read-cache-'));
  const unused = async (): Promise<never> => { throw new Error('Disabled caching must not activate rclone'); };
  const cache = await createDesktopReadCache({ directory, controlDirectory: join(directory, 'control'),
    view: { list: unused, stat: unused, statMany: unused, open },
    control: { call: unused, removeRemote: unused, close: unused }, current: () => true });
  await cache.configure({ maxMiB: 0, maxAgeHours: 168 });
  return { cache, async close() { await cache.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('disabled caching tracks normal reads through EOF without prefetching and can restore quit admission', async () => {
  let pulls = 0; let result: ReadResult | undefined;
  const f = await disabledCache(async () => ({ content: file.handle.content, servedRange: null,
    body: new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(bytes); controller.close(); } }, { highWaterMark: 0 }) }));
  try {
    result = await f.cache.files.open(file, undefined, new AbortController().signal);
    expect(pulls).toBe(0);
    expect(() => f.cache.prepareQuit()).toThrow('仍有 WebDAV 音频正在读取');
    expect(new Uint8Array(await new Response(result.body).arrayBuffer())).toEqual(bytes);
    const resume = f.cache.prepareQuit();
    await expect(f.cache.files.open(file, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'source_failed' });
    resume();
    result = await f.cache.files.open(file, undefined, new AbortController().signal);
    await result.body.cancel();
    expect(await f.cache.inspect()).toMatchObject({ state: 'inactive', actualMode: 'off' });
  } finally { await result?.body.cancel().catch(() => {}); await f.close(); }
});

for (const mode of ['consumer', 'signal'] as const) {
  test(`disabled caching releases ${mode} cancellation before permitting quit`, async () => {
    const cancellations: unknown[] = []; const controller = new AbortController(); let result: ReadResult | undefined;
    const f = await disabledCache(async () => ({ content: file.handle.content, servedRange: null,
      body: new ReadableStream<Uint8Array>({ cancel(reason) { cancellations.push(reason); } }, { highWaterMark: 0 }) }));
    try {
      result = await f.cache.files.open(file, undefined, controller.signal);
      expect(() => f.cache.prepareQuit()).toThrow('仍有 WebDAV 音频正在读取');
      await expect(f.cache.close()).rejects.toMatchObject({ code: 'mount_busy' });
      const reason = new Error('Playback stopped');
      if (mode === 'consumer') await result.body.cancel(reason);
      else {
        controller.abort(reason);
        await expect(new Response(result.body).arrayBuffer()).rejects.toThrow('Playback stopped');
      }
      expect(cancellations).toEqual([reason]);
      f.cache.prepareQuit()();
    } finally { await result?.body.cancel().catch(() => {}); await f.close(); }
  });
}

test('disabled caching blocks quit while open is preparing and keeps its returned stream active', async () => {
  const pending = Promise.withResolvers<ReadResult>();
  const source: ReadResult = { content: file.handle.content, servedRange: null,
    body: new ReadableStream<Uint8Array>({}, { highWaterMark: 0 }) };
  const f = await disabledCache(async () => pending.promise);
  const opening = f.cache.files.open(file, undefined, new AbortController().signal);
  try {
    expect(() => f.cache.prepareQuit()).toThrow('仍有 WebDAV 音频正在读取');
    pending.resolve(source);
    const result = await opening;
    expect(() => f.cache.prepareQuit()).toThrow('仍有 WebDAV 音频正在读取');
    await result.body.cancel();
    f.cache.prepareQuit()();
  } finally {
    pending.resolve(source); await (await opening).body.cancel().catch(() => {}); await f.close();
  }
});

test('a failed uncached open releases its quit reservation', async () => {
  const pending = Promise.withResolvers<ReadResult>(); const failure = new Error('Source preparation failed');
  const f = await disabledCache(async () => pending.promise);
  const opening = f.cache.files.open(file, undefined, new AbortController().signal);
  try {
    expect(() => f.cache.prepareQuit()).toThrow('仍有 WebDAV 音频正在读取');
    pending.reject(failure);
    await expect(opening).rejects.toBe(failure);
    f.cache.prepareQuit()();
  } finally { pending.reject(failure); await opening.catch(() => {}); await f.close(); }
});

test('an obsolete internal cache URL becomes not-found and a fresh source generation remains readable', async () => {
  const { LibraryError } = await import('../src/core/library');
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-stale-read-cache-'));
  let epoch = 1, opens = 0, origin = '', authorization = '', lastPath = '', changeOnOpen = false;
  const bridge = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    lastPath = new URL(request.url).pathname.slice(1);
    const response = await fetch(origin + lastPath, { headers: { Authorization: authorization }, signal: request.signal });
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
  } });
  const unused = async (): Promise<never> => { throw new Error('Unexpected ordinary metadata lookup'); };
  const cache = await createDesktopReadCache({ directory, controlDirectory: join(directory, 'control'),
    current: value => value.handle.stamp.epoch === epoch,
    view: { stat: unused, list: unused, statMany: unused, async open(value) {
      opens++;
      if (changeOnOpen) { epoch++; changeOnOpen = false; }
      if (value.handle.stamp.epoch !== epoch) throw new LibraryError('stale_call', 'Source changed before audio request');
      return { content: value.handle.content, servedRange: null, body: new Blob([bytes]).stream() };
    } },
    control: { async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method === 'serve/list') return { list: [] } as T;
      if (method === 'config/create') {
        const settings = params!.parameters as { url: string; user: string; pass: string };
        origin = settings.url; authorization = `Basic ${btoa(`${settings.user}:${settings.pass}`)}`;
      }
      if (method === 'serve/start') return { id: 'fixture', addr: `127.0.0.1:${bridge.port}` } as T;
      return {} as T;
    }, async removeRemote() {}, async close() {} } });
  try {
    const signal = new AbortController().signal;
    const first = await cache.files.open(file, undefined, signal);
    expect(new Uint8Array(await new Response(first.body).arrayBuffer())).toEqual(bytes);
    const oldUrl = origin + lastPath;
    epoch++;
    // The native cache can still request an old immutable URL after reauthorization.
    const stale = await fetch(oldUrl, { headers: { Authorization: authorization } });
    expect(stale.status).toBe(404); await stale.body?.cancel();
    expect(opens).toBe(1);
    const fresh = structuredClone(file); fresh.handle.stamp.epoch = epoch;
    const next = await cache.files.open(fresh, undefined, signal);
    expect(new Uint8Array(await new Response(next.body).arrayBuffer())).toEqual(bytes);
    expect(origin + lastPath).not.toBe(oldUrl); expect(opens).toBe(2);
    // Also retire a URL when the source changes between metadata and opening.
    const raceUrl = origin + lastPath; changeOnOpen = true;
    const raced = await fetch(raceUrl, { headers: { Authorization: authorization } });
    expect(raced.status).toBe(404); await raced.body?.cancel();
    const repeated = await fetch(raceUrl, { headers: { Authorization: authorization } });
    expect(repeated.status).toBe(404); await repeated.body?.cancel();
    expect(opens).toBe(3);
  } finally { await cache.close(); await bridge.stop(true); await rm(directory, { recursive: true, force: true }); }
});
