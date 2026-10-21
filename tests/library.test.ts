import { afterEach, expect, test } from 'bun:test';
import type { Entry, Outcome, Page, SourcePlugin } from '@musicfs/plugin-api';
import { libraryFixture } from './helpers/library-fixture';
import { nameEntries } from '../src/core/library/names';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
const signal = () => new AbortController().signal;
function plugin(overrides: Partial<SourcePlugin> = {}): SourcePlugin {
  return {
    configuration: { schema: { type: 'object' } }, validateConfig: async (_ctx, candidate) => ({ ok: true, value: candidate }),
    roots: async () => ({ ok: true, value: { items: [{ sourceId: 'root', name: '来源', directoryRef: 'root' }] } }),
    list: async () => ({ ok: true, value: { items: [{ kind: 'file', entryId: 'one', name: '音频.wav', fileRef: 'audio' }] } }),
    stat: async () => ({ ok: true, value: { contentId: 'fixed', size: 8, mediaType: 'audio/wav' } }),
    open: async (_ctx, _file, request) => ({ ok: true, value: { content: { contentId: 'fixed', size: 8, mediaType: 'audio/wav' },
      servedRange: request.range ?? null, body: new Blob([request.range ? 'CD' : 'ABCDEFGH']).stream() } }),
    ...overrides
  };
}
async function setup(source = plugin()) { const result = await libraryFixture(source); cleanups.push(result.close); return result; }
const filePath = '/实例 & #/来源/音频.wav';

test('complete pagination preserves order and duplicate file occurrences', async () => {
  const { library } = await setup(plugin({ list: async (_ctx, _ref, cursor) => ({ ok: true, value: cursor === undefined
    ? { items: [], nextCursor: 'empty-is-not-end' }
    : cursor === 'empty-is-not-end' ? { items: [{ kind: 'file', entryId: 'a', name: '重复.wav', fileRef: 'same' }], nextCursor: 'last' }
    : { items: [{ kind: 'file', entryId: 'b', name: '重复.wav', fileRef: 'same' }] } }) }));
  const entries = await library.files.list('/实例 & #/来源', signal());
  expect(entries).toHaveLength(2); expect(new Set(entries.map(entry => entry.name)).size).toBe(2);
  expect(entries.map(entry => entry.name)).toEqual((await nameEntries([{ id: 'a', name: '重复.wav' }, { id: 'b', name: '重复.wav' }])).map(entry => entry.pathName));
});

test('listed entries retain resolved targets without rereading parent directories and still reject changed sources', async () => {
  const { library, store, sources, id } = await setup();
  const entries = await library.files.list('/实例 & #/来源', signal());
  const entry = entries[0]!; const snapshot = store.snapshot; const header = store.snapshotHeader; let reads = 0; let headers = 0;
  store.snapshot = (...args) => { reads++; return snapshot(...args); };
  store.snapshotHeader = (...args) => { headers++; return header(...args); };
  expect(await library.files.stat(entry, signal())).toMatchObject({ kind: 'file', path: filePath, handle: { content: { size: 8 } } });
  expect(reads).toBe(0);
  expect(await library.files.stat(JSON.parse(JSON.stringify(entry)), signal())).toMatchObject({ kind: 'file', path: filePath });
  expect(reads).toBe(0); expect(headers).toBeGreaterThan(0);
  await sources.configure(id, { changed: true }, signal());
  await expect(library.files.stat(entry, signal())).rejects.toMatchObject({ code: 'stale_call' });
});

test('prepared metadata batches and single-file requests reuse published info with source checks', async () => {
  let count = 1; let metadataCalls = 0;
  const source = plugin({ list: async () => ({ ok: true, value: { items: Array.from({ length: count }, (_, index) => ({
    kind: 'file' as const, entryId: `entry-${index}`, name: `${index}.wav`, fileRef: `file-${index}`,
    info: { contentId: `prepared-${index}`, size: index + 10, mediaType: 'audio/wav' }
  })) } }), stat: async () => { metadataCalls++; return { ok: true, value: { contentId: 'live', size: 8, mediaType: 'audio/wav' } }; } });
  const { library, store, id } = await setup(source);
  const current = store.current; const snapshot = store.snapshot; let checks = 0; let reads = 0;
  store.current = stamp => { checks++; return current(stamp); };
  store.snapshot = (...args) => { reads++; return snapshot(...args); };
  for (count of [1, 96]) {
    await library.refresh(id, 'root', signal());
    const entries = await library.files.list('/实例 & #/来源', signal()); checks = 0; reads = 0;
    const values = await library.files.statMany(entries, signal());
    expect(values.size).toBe(count); expect(checks).toBe(2); expect(reads).toBe(0); expect(metadataCalls).toBe(0);
    for (let index = 0; index < count; index++) expect(values.get(entries[index]!)).toMatchObject({ kind: 'file',
      handle: { content: { contentId: `prepared-${index}`, size: index + 10, mediaType: 'audio/wav' } } });
  }
  const [entry] = await library.files.list('/实例 & #/来源', signal());
  expect(await library.files.stat(entry!, signal())).toMatchObject({ handle: { content: { contentId: 'prepared-0', size: 10 } } });
  expect(metadataCalls).toBe(0);
});

test('a source change during batch description rejects every entry from that source', async () => {
  let metadataCalls = 0;
  const source = plugin({ list: async () => ({ ok: true, value: { items: ['one', 'two'].map(entryId => ({ kind: 'file' as const,
    entryId, name: `${entryId}.wav`, fileRef: entryId, info: { contentId: entryId, size: 8, mediaType: 'audio/wav' } })) } }),
  stat: async () => { metadataCalls++; return { ok: true, value: { contentId: 'live', size: 8, mediaType: 'audio/wav' } }; } });
  const { library, sources, id } = await setup(source);
  const entries = await library.files.list('/实例 & #/来源', signal());
  const current = sources.current; let checks = 0;
  sources.current = async stamp => {
    const valid = await current(stamp);
    if (++checks === 1) await sources.configure(id, { changed: true }, signal());
    return valid;
  };
  const values = await library.files.statMany(entries, signal());
  expect(checks).toBe(2); expect(metadataCalls).toBe(0);
  for (const entry of entries) expect(values.get(entry)).toMatchObject({ code: 'stale_call' });
  const stale = await library.files.statMany(entries, signal());
  for (const entry of entries) expect(stale.get(entry)).toMatchObject({ code: 'stale_call' });
  await expect(library.files.stat(entries[0]!, signal())).rejects.toMatchObject({ code: 'stale_call' });
});

test('prepared single and batch metadata use the same validator despite object property order', async () => {
  const { library } = await setup(plugin({ list: async () => ({ ok: true, value: { items: [{ kind: 'file', entryId: 'one', name: '音频.wav',
    fileRef: 'audio', info: { mediaType: 'audio/wav', size: 8, contentId: 'fixed' } }] } }) }));
  const entries = await library.files.list('/实例 & #/来源', signal()); const entry = entries[0]!;
  const described = (await library.files.statMany(entries, signal())).get(entry)!;
  if (described instanceof Error) throw described;
  expect(described.etag).toBe((await library.files.stat(entry, signal())).etag);
});

test('unchanged file modification time survives refresh for listings and DAV metadata', async () => {
  let size = 8; let modifiedAt = '2026-10-20T10:00:00.000Z';
  const info = () => ({ contentId: `bytes-${size}`, size, mediaType: 'audio/wav', modifiedAt });
  const { library, id } = await setup(plugin({ list: async () => ({ ok: true, value: { items: [
    { kind: 'file', entryId: 'one', name: '音频.wav', fileRef: 'audio', info: info() }
  ] } }), stat: async () => ({ ok: true, value: info() }) }));
  const [before] = await library.files.list('/实例 & #/来源', signal());
  const etag = (await library.files.stat(before!, signal())).etag;
  await library.refresh(id, 'root', signal());
  const [after] = await library.files.list('/实例 & #/来源', signal());
  expect(after!.modifiedAt).toBe(modifiedAt);
  expect((await library.files.statMany([after!], signal())).get(after!)).toMatchObject({ modifiedAt, etag });
  expect(await library.files.stat(filePath, signal())).toMatchObject({ modifiedAt, etag });
  size = 9; modifiedAt = '2026-10-21T10:00:00.000Z';
  await library.refresh(id, 'root', signal());
  expect(await library.files.stat(filePath, signal())).toMatchObject({ modifiedAt });
  expect((await library.files.stat(filePath, signal())).etag).not.toBe(etag);
});

test('batch source checks also cover changes while another source is still being described', async () => {
  let changeFirst = async () => {};
  const source = plugin({ list: async ctx => ({ ok: true, value: { items: [{ kind: 'file', entryId: 'one', name: '音频.wav', fileRef: 'audio',
    ...((ctx.config as { legacy?: boolean }).legacy ? {} : { info: { contentId: 'fixed', size: 8, mediaType: 'audio/wav' } }) }] } }),
  stat: async () => { await changeFirst(); return { ok: true, value: { contentId: 'fixed', size: 8, mediaType: 'audio/wav' } }; } });
  const { library, sources, id } = await setup(source);
  const other = await sources.create('org.musicfs.sample', '另一个实例', { legacy: true }, signal());
  if (!other.ok) throw new Error('Cannot create second metadata fixture');
  const firstEntries = await library.files.list('/实例 & #/来源', signal());
  const otherEntries = await library.files.list('/另一个实例/来源', signal());
  changeFirst = async () => { await sources.configure(id, { changed: true }, signal()); };
  const values = await library.files.statMany([...firstEntries, ...otherEntries], signal());
  expect(values.get(firstEntries[0]!)).toMatchObject({ code: 'stale_call' });
  expect(values.get(otherEntries[0]!)).toMatchObject({ kind: 'file', handle: { content: { size: 8 } } });
});

test('metadata batches preserve live per-file stat for plugins without prepared info', async () => {
  const calls: string[] = [];
  const { library } = await setup(plugin({ list: async () => ({ ok: true, value: { items: ['one', 'two'].map(entryId => ({
    kind: 'file' as const, entryId, name: `${entryId}.wav`, fileRef: entryId
  })) } }), stat: async (_ctx, file) => { calls.push(file); return { ok: true, value: { contentId: file, size: 8, mediaType: 'audio/wav' } }; } }));
  const entries = await library.files.list('/实例 & #/来源', signal());
  const values = await library.files.statMany(entries, signal());
  expect(calls).toEqual(['one', 'two']);
  for (const entry of entries) expect(values.get(entry)).toMatchObject({ kind: 'file', handle: { content: { size: 8, mediaType: 'audio/wav' } } });
});

test('single-file metadata for legacy plugins stays live and notices changed representations', async () => {
  let calls = 0; let version = 1;
  const { library } = await setup(plugin({ stat: async () => {
    calls++; return { ok: true, value: { contentId: `bytes-${version}`, size: version + 7, mediaType: 'audio/wav' } };
  } }));
  const before = await library.files.stat(filePath, signal());
  expect((await library.files.stat(filePath, signal())).etag).toBe(before.etag);
  version = 2;
  const after = await library.files.stat(filePath, signal());
  expect(after).toMatchObject({ handle: { content: { contentId: 'bytes-2', size: 9 } } });
  expect(after.etag).not.toBe(before.etag); expect(calls).toBe(3);
});

test('invalid prepared info on a later page cannot replace the complete previous snapshot', async () => {
  const source = plugin(); const { library, store, id } = await setup(source);
  const previous = await library.refresh(id, 'root', signal());
  const content = { contentId: 'prepared', size: 8, mediaType: 'audio/wav' };
  for (const invalid of [{ ...content, contentId: '' }, { ...content, size: -1 }, { ...content, mediaType: 'not-a-media-type' }]) {
    source.list = async (_ctx, _ref, cursor) => ({ ok: true, value: cursor === undefined ? { items: [{ kind: 'file', entryId: 'first',
      name: 'first.wav', fileRef: 'first', info: content }], nextCursor: 'last' } : { items: [{ kind: 'file', entryId: 'bad', name: 'bad.wav', fileRef: 'bad', info: invalid }] } });
    await expect(library.refresh(id, 'root', signal())).rejects.toMatchObject({ code: 'invalid_source' });
    expect(store.snapshot(id, { kind: 'directory', ref: 'root' })?.value).toEqual(previous);
  }
});

test('failed refresh retains the complete previous snapshot and leaves layout untouched', async () => {
  const source = plugin(); const { library, store, id } = await setup(source);
  const layout = await library.saveLayout(0, [{ kind: 'group', id: 'group', name: '音乐', children: [{ kind: 'source', id: 'source', name: '我的来源', instanceId: id, sourceId: 'root' }] }]);
  expect((await library.files.list('/音乐/我的来源', signal()))).toHaveLength(1);
  const previous = store.snapshot(id, { kind: 'directory', ref: 'root' });
  source.list = async () => ({ ok: false, error: { kind: 'unavailable', message: 'Fixture source unavailable' } });
  await expect(library.refresh(id, 'root', signal())).rejects.toThrow('Fixture source unavailable');
  expect(store.snapshot(id, { kind: 'directory', ref: 'root' })?.value).toEqual(previous?.value);
  expect(store.snapshot(id, { kind: 'directory', ref: 'root' })?.error).toBe('unavailable');
  expect(await library.layout()).toEqual(layout);
  expect(await library.files.list('/音乐/我的来源', signal())).toHaveLength(1);
});

test('cyclic cursors and invalid references cannot publish a partial snapshot', async () => {
  const { library, store, id } = await setup(plugin({ list: async () => ({ ok: true, value: { items: [], nextCursor: 'same' } }) }));
  await expect(library.refresh(id, 'root', signal())).rejects.toThrow('cyclic');
  expect(store.snapshot(id, { kind: 'directory', ref: 'root' })?.value).toBeNull();
  const bad = await setup(plugin({ list: async () => ({ ok: true, value: { items: [{ kind: 'file', entryId: 'broken', name: 'broken.wav', fileRef: 42 as unknown as string }] } }) }));
  await expect(bad.library.refresh(bad.id, 'root', signal())).rejects.toMatchObject({ code: 'invalid_source' });
  expect(bad.store.snapshot(bad.id, { kind: 'directory', ref: 'root' })?.value).toBeNull();
});

test('a superseded refresh cannot replace a newer successful directory', async () => {
  const pending = Promise.withResolvers<Outcome<Page<Entry>>>(); const started = Promise.withResolvers<void>(); let calls = 0;
  const { library, store, id } = await setup(plugin({ list: async () => {
    if (++calls === 1) { started.resolve(); return pending.promise; }
    return { ok: true, value: { items: [{ kind: 'file', entryId: 'new', name: 'new.wav', fileRef: 'new' }] } };
  } }));
  const old = library.refresh(id, 'root', signal()); await started.promise;
  const current = await library.refresh(id, 'root', signal());
  pending.resolve({ ok: true, value: { items: [] } });
  await expect(old).rejects.toMatchObject({ code: 'stale_call' });
  expect(store.snapshot(id, { kind: 'directory', ref: 'root' })?.value).toEqual(current);
});

test('configuration changes invalidate in-flight refresh publication', async () => {
  const pending = Promise.withResolvers<Outcome<Page<Entry>>>(); const started = Promise.withResolvers<void>();
  const { library, sources, store, id } = await setup(plugin({ list: async () => { started.resolve(); return pending.promise; } }));
  const old = library.refresh(id, 'root', signal()); await started.promise;
  await sources.configure(id, { changed: true }, signal()); pending.resolve({ ok: true, value: { items: [] } });
  await expect(old).rejects.toMatchObject({ code: 'stale_call' });
  expect(store.snapshot(id, { kind: 'directory', ref: 'root' })?.value).toBeNull();
});

test('portable duplicate names remain deterministic after reorder and fit UTF-8 limits', async () => {
  const input = [{ id: 'a', name: 'CON' }, { id: 'b', name: 'CON' }, { id: 'c', name: '汉'.repeat(200) + '.flac' },
    { id: 'case-a', name: 'Case.FLAC' }, { id: 'case-b', name: 'case.flac' },
    { id: 'accent-a', name: 'e\u0301.flac' }, { id: 'accent-b', name: 'é.flac' }];
  const first = await nameEntries(input); const second = await nameEntries([...input].reverse());
  for (const item of first) {
    expect(new TextEncoder().encode(item.pathName).byteLength).toBeLessThanOrEqual(255);
    expect(second.find(entry => entry.id === item.id)?.pathName).toBe(item.pathName);
    expect(item.pathName).not.toBe('CON');
  }
  expect(new Set(first.map(entry => entry.pathName.normalize('NFC').toLowerCase())).size).toBe(input.length);
  expect(first.find(entry => entry.id === 'c')?.pathName.endsWith('.flac')).toBe(true);
});

test('layout uses revision checks and supports missing-plugin references', async () => {
  const { library } = await setup();
  await library.saveLayout(0, [{ kind: 'source', id: 'missing', name: '保留', instanceId: 'missing-instance', sourceId: 'missing-source' }]);
  await expect(library.saveLayout(0, [])).rejects.toMatchObject({ code: 'conflict' });
  expect(await library.files.list('/', signal())).toMatchObject([{ name: '保留' }]);
  await expect(library.saveLayout(1, [{ kind: 'group', id: 'dup', name: 'a', children: [{ kind: 'group', id: 'dup', name: 'b', children: [] }] }])).rejects.toMatchObject({ code: 'invalid_layout' });
});

test('range bytes are exact and an upstream full response is cancelled and rejected', async () => {
  const source = plugin(); const { library } = await setup(source);
  const file = await library.files.stat(filePath, signal()); if (file.kind !== 'file') throw new Error('Missing fixture');
  const result = await library.files.open(file, { start: 2, end: 3 }, signal());
  expect(await new Response(result.body).text()).toBe('CD');
  let cancelled = false;
  source.open = async () => ({ ok: true, value: { content: file.handle.content, servedRange: null, body: new ReadableStream({ cancel() { cancelled = true; } }) } });
  await expect(library.files.open(file, { start: 2, end: 3 }, signal())).rejects.toMatchObject({ code: 'range_unsupported' });
  expect(cancelled).toBe(true);
});
test('a changed representation is cancelled rather than returned under old metadata', async () => {
  const source = plugin({ list: async () => ({ ok: true, value: { items: [{ kind: 'file', entryId: 'one', name: '音频.wav', fileRef: 'audio',
    info: { contentId: 'fixed', size: 8, mediaType: 'audio/wav' } }] } }) });
  const { library } = await setup(source);
  const file = await library.files.stat(filePath, signal()); if (file.kind !== 'file') throw new Error('Missing fixture');
  let cancelled = false;
  source.open = async () => ({ ok: true, value: { content: { ...file.handle.content, contentId: 'different-bytes' }, servedRange: null,
    body: new ReadableStream({ cancel() { cancelled = true; } }) } });
  await expect(library.files.open(file, undefined, signal())).rejects.toMatchObject({ code: 'content_changed' }); expect(cancelled).toBe(true);
});

for (const bytes of ['SHORT', 'TOO-LONG-BYTES']) test(`incorrect audio length (${bytes.length}) fails through the returned stream`, async () => {
  const source = plugin({ open: async () => ({ ok: true, value: { content: { contentId: 'fixed', size: 8, mediaType: 'audio/wav' }, servedRange: null, body: new Blob([bytes]).stream() } }) });
  const { library } = await setup(source);
  const file = await library.files.stat(filePath, signal()); if (file.kind !== 'file') throw new Error('Missing fixture');
  const result = await library.files.open(file, undefined, signal());
  await expect(new Response(result.body).arrayBuffer()).rejects.toThrow();
});

test('library persists complete page counters, reads diagnostics without a source request and invalidates them on configuration changes', async () => {
  let calls = 0;
  const source = plugin({ statistics: { records: '项目', files: '文件' }, list: async (_ctx, _ref, cursor) => {
    calls++;
    return { ok: true, value: { items: [], statistics: { records: cursor ? 2 : 3, files: cursor ? 1 : 0 }, ...(cursor ? {} : { nextCursor: 'last' }) } };
  } });
  const { library, store, sources, id } = await setup(source);
  expect(await library.directoryStatus(id, 'root')).toBeNull(); expect(calls).toBe(0);
  await library.refresh(id, 'root', signal());
  const status = await library.directoryStatus(id, 'root');
  expect(status?.statistics).toEqual({ records: 5, files: 1 }); expect(calls).toBe(2);
  expect(store.snapshot(id, { kind: 'directory', ref: 'root' })?.value?.statistics).toEqual(status?.statistics ?? undefined);
  await sources.configure(id, { revision: 2 }, signal()); expect(await library.directoryStatus(id, 'root')).toBeNull();
});

test('invalid, inconsistent and overflowing counters cannot replace the last successful statistics', async () => {
  const source = plugin({ list: async () => ({ ok: true, value: { items: [], statistics: { records: 4 } } }) });
  const { library, id } = await setup(source); await library.refresh(id, 'root', signal());
  const before = await library.directoryStatus(id, 'root');
  if (!before) throw new Error('Missing initial directory status');
  for (const invalid of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    source.list = async () => ({ ok: true, value: { items: [], statistics: { records: invalid } } });
    await expect(library.refresh(id, 'root', signal())).rejects.toMatchObject({ code: 'invalid_source' });
    expect(await library.directoryStatus(id, 'root')).toEqual({ ...before, error: 'invalid_source' });
  }
  source.list = async (_ctx, _ref, cursor) => ({ ok: true, value: cursor ? { items: [] } : { items: [], statistics: { records: 1 }, nextCursor: 'last' } });
  await expect(library.refresh(id, 'root', signal())).rejects.toMatchObject({ code: 'invalid_source' });
  source.list = async (_ctx, _ref, cursor) => ({ ok: true, value: { items: [], statistics: { records: Number.MAX_SAFE_INTEGER }, ...(cursor ? {} : { nextCursor: 'last' }) } });
  await expect(library.refresh(id, 'root', signal())).rejects.toMatchObject({ code: 'invalid_source' });
  expect(await library.directoryStatus(id, 'root')).toEqual({ ...before, error: 'invalid_source' });
});
