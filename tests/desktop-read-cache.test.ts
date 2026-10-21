import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileView } from '../src/core/library';
import { createDesktopReadCache } from '../src/hosts/desktop/read-cache';

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
