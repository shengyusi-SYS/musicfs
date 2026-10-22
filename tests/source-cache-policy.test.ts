import { expect, test } from 'bun:test';
import type { Json, SourcePlugin } from '@musicfs/plugin-api';
import { libraryFixture } from './helpers/library-fixture';
import { contentConfiguration as neteaseIdentity } from '../plugins/netease/configuration';
import { contentConfiguration as qqIdentity } from '../plugins/qq/configuration';

test('plugin-declared retention changes preserve published files and cached data; audio changes still invalidate', async () => {
  const source: SourcePlugin = {
    contentConfiguration: config => { const { days: _days, ...content } = config as { [key: string]: Json }; return content; },
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, value) => ({ ok: true, value }),
    roots: async () => ({ ok: true, value: { items: [{ sourceId: 'root', name: '音乐', directoryRef: 'root' }] } }),
    list: async ctx => { await ctx.cache!.put('retained', 'yes'); return { ok: true, value: { items: [
      { kind: 'file', entryId: 'song', name: 'song.mp3', fileRef: 'song', info: { contentId: 'song', size: 1, mediaType: 'audio/mpeg' } }
    ] } }; },
    stat: async () => { throw new Error('Published info must survive policy edits'); },
    open: async ctx => ({ ok: true, value: { content: { contentId: 'song', size: 1, mediaType: 'audio/mpeg' }, servedRange: null,
      body: new Blob([String(await ctx.cache!.get('retained'))]).stream() } })
  };
  const f = await libraryFixture(source, { quality: 'standard', days: 7 }); const signal = new AbortController().signal;
  try {
    const description = await f.library.files.stat('/实例 & #/音乐/song.mp3', signal);
    const before = f.store.capture(f.id)!;
    expect((await f.sources.configure(f.id, { quality: 'standard', days: 365 }, signal)).ok).toBe(true);
    const after = f.store.capture(f.id)!;
    expect(after.epoch).toBe(before.epoch); expect(after.stateRevision).toBeGreaterThan(before.stateRevision);
    expect(f.store.cachedPluginData(after, 'retained', Date.now())).toBe('"yes"');
    expect(await f.library.files.stat('/实例 & #/音乐/song.mp3', signal)).toEqual(description);
    await f.sources.configure(f.id, { quality: 'lossless', days: 365 }, signal);
    expect(f.store.capture(f.id)!.epoch).toBe(before.epoch + 1);
    expect(f.store.cachedPluginData(f.store.capture(f.id)!, 'retained', Date.now())).toBeUndefined();
    if (description.kind !== 'file') throw new Error('Missing published song');
    await expect(f.library.files.open(description, undefined, signal)).rejects.toMatchObject({ code: 'stale_call' });
  } finally { f.close(); }
});

test('both example identities exclude retention only', () => {
  for (const identity of [neteaseIdentity, qqIdentity]) {
    expect(identity({ metadataCacheDays: 7 })).toEqual(identity({ metadataCacheDays: 365 }));
    expect(identity({ metadataCacheDays: 0, label: 'Renamed' })).not.toEqual(identity({}));
    expect(identity({ audio: { qualities: ['lossless'] } })).not.toEqual(identity({}));
  }
});
