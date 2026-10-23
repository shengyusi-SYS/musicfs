import { expect, test } from 'bun:test';
import type { LayoutNode, SourceInstance } from '../src/contracts/management';
import type { Api } from '../src/web/api';
import { currentLayoutLocation, exportedMusic, layoutLocation, sourceLocation, type MusicLocation } from '../src/web/components/music-navigation';
import { groupListing, listingQuery } from '../src/web/components/music-listing';
import { editNode, moveToFolder } from '../src/web/pages/layout-draft';

const instance: SourceInstance = { id: 'account', pluginId: 'example', name: '音乐账号', epoch: 1, config: {} };
const alias: LayoutNode = { id: 'alias', name: '我的歌单', kind: 'source', instanceId: instance.id, sourceId: 'playlists' };
const original: LayoutNode[] = [{ id: 'folder', kind: 'group', name: '常听', children: [alias] }, { id: 'other', kind: 'group', name: '出门', children: [] }];
const roots = [{ sourceId: 'playlists', name: '来源中的歌单', directoryRef: 'opaque/root' }];

test('a nested source directory stays open when its draft alias is moved and renamed', () => {
  const anchor = layoutLocation(original, 'alias');
  const nested: MusicLocation = { name: '通勤', target: { kind: 'layout', nodeId: 'alias', directoryRef: 'opaque/child' }, ancestors: [...anchor.ancestors, anchor] };
  const moved = editNode(moveToFolder(original, 'alias', 'other'), 'alias', node => ({ ...node, name: '随身歌单' }));
  const current = currentLayoutLocation(moved, nested);
  expect(current.target).toEqual(nested.target);
  expect(current.ancestors.map(crumb => crumb.name)).toEqual(['播放器目录', '出门', '随身歌单']);
  expect(current.name).toBe('通勤');
  expect(currentLayoutLocation(editNode(moved, 'alias', () => null), current)).toEqual(exportedMusic);
});

test('unpublished groups list the draft children without a directory fetch', () => {
  expect(groupListing(original, layoutLocation(original, 'folder'))?.entries).toEqual([
    { name: '我的歌单', kind: 'directory', modifiedAt: '', location: layoutLocation(original, 'alias') }
  ]);
  expect(groupListing(original, layoutLocation(original, 'other'))?.entries).toEqual([]);
  expect(listingQuery({} as Api, layoutLocation(original, 'folder'), [instance], original, roots).enabled).toBe(false);
});

test('raw source and draft aliases share snapshot data while retaining their own breadcrumbs', async () => {
  let reads = 0;
  const api = { browseSourceDirectory: async (instanceId: string, ref: string) => {
    reads++; expect(instanceId).toBe(instance.id); expect(ref).toBe('opaque/root');
    return { entries: [{ name: '通勤', kind: 'directory' as const, modifiedAt: '', directoryRef: 'opaque/child' }], status: null };
  } } as unknown as Api;
  const raw: MusicLocation = { name: '来源中的歌单', target: { kind: 'source', instanceId: instance.id, directoryRef: 'opaque/root' }, ancestors: [sourceLocation(instance)] };
  const direct = listingQuery(api, raw, [instance], original, roots);
  const mapped = listingQuery(api, layoutLocation(original, 'alias'), [instance], original, roots);
  expect(mapped.queryKey).toEqual(direct.queryKey);
  const cached = await direct.queryFn({ signal: new AbortController().signal });
  expect(direct.select(cached).entries[0]?.location?.ancestors.map(crumb => crumb.name)).toEqual(['音乐账号', '来源中的歌单']);
  expect(mapped.select(cached).entries[0]?.location?.ancestors.map(crumb => crumb.name)).toEqual(['播放器目录', '常听', '我的歌单']);
  expect(reads).toBe(1);
});

test('an unresolved layout reference cannot accidentally browse the source account root', () => {
  const query = listingQuery({} as Api, layoutLocation(original, 'alias'), [instance], original, []);
  expect(query.enabled).toBe(false);
});
