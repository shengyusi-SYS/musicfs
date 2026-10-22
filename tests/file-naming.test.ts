import { expect, test } from 'bun:test';
import type { Entry } from '@musicfs/plugin-api';
import { DEFAULT_TEMPLATE_POLICY, type FileNamingPolicy, type FileNamingRecord } from '../src/contracts/file-naming';
import { assertEntryNaming, createFileNaming, parseFileNamingPolicy, previewFileNames, projectFileNames, resolveFileNamingPolicy, type NamingStore } from '../src/core/library/file-naming';
import { nameEntries } from '../src/core/library/names';

const policy = (template: string): FileNamingPolicy => ({ ...DEFAULT_TEMPLATE_POLICY, template });
const file = (id: string, title = '晴天', index = 1): Extract<Entry, { kind: 'file' }> => ({
  kind: 'file', entryId: `${index}:${id}`, name: `${index}. ${title}.flac`, fileRef: `audio:${id}`,
  naming: { identity: id, fields: { id, title, artist: ['A&B', '歌手'], index, quality: '无损' } },
  info: { contentId: id, size: 123, mediaType: 'audio/flac', modifiedAt: '2020-01-01T00:00:00Z' }
});
const allocate = async (entries: Entry[], input = policy('{{title}} - {{artist}}')) => nameEntries(projectFileNames(entries, input).map(entry => ({ ...entry, id: entry.entryId })));

test('filename templates use literal text, optional sections, actual extension and shared formatting', async () => {
  const source = file('one'); source.naming!.fields.track = 2;
  const rendered = await allocate([source], policy('{{#track}}{{track}} - {{/track}}{{title}} - {{artist}} [{{quality}}]'));
  expect(rendered[0]!.pathName).toBe('02 - 晴天 - A&B、歌手 [无损].flac');
  expect(rendered[0]!).toMatchObject({ fileRef: source.fileRef, info: source.info });
  const absent = await allocate([file('two')], policy('{{#track}}{{track}} - {{/track}}{{title}}'));
  expect(absent[0]!.pathName).toBe('晴天.flac');
});

test('template projection leaves directories and old plugin snapshots usable', async () => {
  const legacy: Entry = { kind: 'file', entryId: 'old', name: 'Original.mp3', fileRef: 'old' };
  const directory: Entry = { kind: 'directory', entryId: 'directory', name: 'Album', directoryRef: 'album' };
  expect(projectFileNames([legacy, directory], policy('{{title}}'))).toEqual([legacy, directory]);
  expect((await allocate([legacy], policy('Copy - {{originalName}}')))[0]!.pathName).toBe('Copy - Original.mp3');
  expect(projectFileNames([file('one')], policy('{{album}}'))[0]!.name).toBe(file('one').name);
});

test('same-name suffixes and duplicate occurrences survive unrelated insertions and directory reordering', async () => {
  const first = [file('a', 'Same', 1), file('b', 'Same', 2), file('a', 'Same', 3)];
  const before = await allocate(first, policy('{{title}}'));
  const after = await allocate([file('new', 'New', 1), file('b', 'Same', 2), file('a', 'Same', 3), file('a', 'Same', 4)], policy('{{title}}'));
  expect(before.map(entry => entry.pathName).sort()).toEqual(after.filter(entry => entry.kind === 'file' && entry.fileRef !== 'audio:new').map(entry => entry.pathName).sort());
  expect(new Set(before.map(entry => entry.pathName)).size).toBe(3);
  const original = await allocate(first, { mode: 'original' });
  expect(original.map(entry => entry.pathName)).toEqual(first.map(entry => entry.name));
});

test('preview allocates collisions over the complete directory even when display is limited', async () => {
  const entries = [file('one', 'same'), file('two', 'same', 2)];
  const preview = await previewFileNames(entries, policy('{{title}}{{#album}} - {{album}}{{/album}}'), 1);
  expect(preview.total).toBe(2); expect(preview.changed).toBe(2); expect(preview.items).toHaveLength(1);
  expect(preview.items[0]!.after).toMatch(/^same \[[a-f0-9]{8}\]\.flac$/);
  expect(preview.missingFields).toEqual(['album']);
});

test('preview compares against current projected names including stable collision suffixes', async () => {
  const entries = [file('one', 'same'), file('two', 'same', 2)]; const current = policy('{{title}}');
  const unchanged = await previewFileNames(entries, current, 20, current);
  expect(unchanged.changed).toBe(0); expect(unchanged.items.every(item => item.before === item.after)).toBe(true);
  const reverted = await previewFileNames(entries, { mode: 'original' }, 20, current);
  expect(reverted.changed).toBe(2);
  expect(reverted.items.map(item => item.after)).toEqual(entries.map(entry => entry.name));
  expect(reverted.items[0]!.before).toMatch(/^same \[[a-f0-9]{8}\]\.flac$/);
});

test('Mustache validation reports syntax and undeclared fields before saving', () => {
  expect(() => parseFileNamingPolicy(policy('{{#title}}broken'))).toThrow('语法');
  expect(() => parseFileNamingPolicy(policy('{{unknown}}'), { title: '歌名' })).toThrow('unknown');
  expect(() => parseFileNamingPolicy(policy('{{> partial}}'))).toThrow('支持字段');
  expect(parseFileNamingPolicy(policy('{{title}}'), { title: '歌名' })).toEqual(policy('{{title}}'));
  expect(() => assertEntryNaming({ ...file('one'), naming: { identity: '', fields: {} } })).toThrow('命名资料');
});

test('instance defaults and direct directory overrides share one effective policy', async () => {
  let instance: FileNamingRecord = { revision: 0, policy: null }; let directory: FileNamingRecord | null = null; let writes = 0;
  const store: NamingStore = {
    fileNamingPolicies: (_id, ref) => ({ instance, directory: ref === undefined ? null : directory }),
    saveFileNamingPolicy(_id, ref, revision, next) {
      const current = ref === undefined ? instance : directory ?? { revision: 0, policy: null };
      if (current.revision !== revision) return false;
      const record = { revision: revision + 1, policy: next };
      if (ref === undefined) instance = record; else directory = record;
      writes++; return true;
    }
  };
  const naming = createFileNaming(store, async () => ({ title: '歌名' }));
  expect((await naming.get('instance', 'album')).effectivePolicy).toEqual({ mode: 'original' });
  await naming.set('instance', undefined, 0, policy('{{title}}'));
  const inherited = await naming.get('instance', 'album'); expect(inherited.inherited).toBe(true); expect(inherited.fields.originalName).toBeDefined();
  await naming.set('instance', 'album', 0, { mode: 'original' });
  expect((await naming.get('instance', 'album')).effectivePolicy).toEqual({ mode: 'original' });
  await naming.set('instance', 'album', 1, null);
  expect((await naming.get('instance', 'album')).effectivePolicy).toEqual(policy('{{title}}'));
  expect(resolveFileNamingPolicy({ instance, directory })).toEqual(policy('{{title}}'));
  await naming.set('instance', undefined, 1, policy('{{title}}')); expect(writes).toBe(3);
  await expect(naming.set('instance', undefined, 0, policy('{{title}}'))).rejects.toThrow('已变化');
});
