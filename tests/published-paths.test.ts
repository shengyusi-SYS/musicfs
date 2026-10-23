import { expect, test } from 'bun:test';
import { publishedPaths } from '../src/core/library/published-paths';
import { libraryFixture } from './helpers/library-fixture';
import type { SourcePlugin } from '@musicfs/plugin-api';

test('publication paths follow persisted nested folders and all layout aliases without requesting the source', async () => {
  let calls = 0;
  const plugin: SourcePlugin = {
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, value) => ({ ok: true, value }),
    roots: async () => { calls++; return { ok: true, value: { items: [{ sourceId: 'root', name: '音乐', directoryRef: 'root' }] } }; },
    list: async (_ctx, ref) => { calls++; return { ok: true, value: { items: ref === 'root'
      ? [{ kind: 'directory', entryId: 'album', name: 'A&B', directoryRef: 'album' }]
      : [{ kind: 'file', entryId: 'song', name: 'song.mp3', fileRef: 'song' }] } }; },
    stat: async () => ({ ok: true, value: { contentId: 'song', size: 1, mediaType: 'audio/mpeg' } }),
    open: async () => { throw new Error('Path lookup must not read audio'); }
  };
  const f = await libraryFixture(plugin);
  try {
    await f.library.refresh(f.id, undefined, new AbortController().signal);
    await f.library.refresh(f.id, 'root', new AbortController().signal);
    const stamp = await f.sources.view(f.id); const before = calls;
    expect(await publishedPaths(f.sources, f.store, stamp, { kind: 'directory', ref: 'album' })).toEqual(['/实例 & #/音乐/A&B']);
    await f.library.saveLayout(0, [{ kind: 'group', id: 'group', name: '我的', children: [
      { kind: 'source', id: 'one', name: '入口一', instanceId: f.id, sourceId: 'root' },
      { kind: 'source', id: 'two', name: '入口二', instanceId: f.id, sourceId: 'root' },
      { kind: 'source', id: 'single', name: '独立专辑', instanceId: f.id, sourceId: 'root', directoryRef: 'album' }
    ] }]);
    expect(await publishedPaths(f.sources, f.store, stamp, { kind: 'directory', ref: 'album' })).toEqual(['/我的/独立专辑', '/我的/入口一/A&B', '/我的/入口二/A&B']);
    expect(await publishedPaths(f.sources, f.store, stamp, { kind: 'roots', ref: '' })).toEqual(['/我的/入口一', '/我的/入口二', '/我的/独立专辑']);
    expect(calls).toBe(before);
  } finally { f.close(); }
});
