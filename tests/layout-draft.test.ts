import { expect, test } from 'bun:test';
import type { LayoutNode } from '../src/contracts/management';
import { appendNodes, filterNodes, folderOptions, locateNode, moveNode, moveToFolder } from '../src/web/pages/layout-draft';

test('moving a content reference across groups preserves its identity and the other occurrences', () => {
  const first: LayoutNode = { kind: 'source', id: 'first', name: '入口', instanceId: 'a', sourceId: 'root' };
  const second: LayoutNode = { ...first, id: 'second' };
  const original: LayoutNode[] = [{ kind: 'group', id: 'left', name: '左', children: [first] }, { kind: 'group', id: 'right', name: '右', children: [second] }];
  expect(moveNode(original, 'first', 'second', 'after')).toEqual([{ kind: 'group', id: 'left', name: '左', children: [] }, { kind: 'group', id: 'right', name: '右', children: [second, first] }]);
  expect(original[0]).toMatchObject({ children: [first] });
});

test('a drag cannot create a cycle, drop into a source, or lose a node through a missing target', () => {
  const original: LayoutNode[] = [{ kind: 'group', id: 'parent', name: '分组', children: [{ kind: 'group', id: 'child', name: '下级', children: [] }] }, { kind: 'source', id: 'file', name: '入口', instanceId: 'a', sourceId: 'r' }];
  expect(moveNode(original, 'parent', 'child', 'inside')).toBe(original);
  expect(moveNode(original, 'parent', 'file', 'inside')).toBe(original);
  expect(moveNode(original, 'child', 'missing', 'after')).toBe(original);
  expect(moveNode(original, 'parent', 'parent', 'before')).toBe(original);
});

test('batch additions and explicit moves keep source occurrences and insertion order', () => {
  const first: LayoutNode = { kind: 'source', id: 'one', name: '歌单', instanceId: 'a', sourceId: 'root' };
  const second: LayoutNode = { ...first, id: 'two' };
  const original: LayoutNode[] = [{ kind: 'group', id: 'folder', name: '常听', children: [] }];
  const added = appendNodes(original, 'folder', [first, second]);
  expect(locateNode(added, 'two')).toMatchObject({ parentId: 'folder', index: 1, siblings: [first, second] });
  const moved = moveToFolder(added, 'one', null);
  expect(moved).toEqual([{ kind: 'group', id: 'folder', name: '常听', children: [second] }, first]);
  expect(moveToFolder(added, 'folder', 'folder')).toBe(added);
  expect(moveToFolder(added, 'one', 'folder')).toBe(added);
  expect(original[0]).toMatchObject({ children: [] });
});

test('tree search retains ancestors while move destinations exclude the moved subtree', () => {
  const original: LayoutNode[] = [{ kind: 'group', id: 'parent', name: '常听', children: [
    { kind: 'group', id: 'child', name: '摇滚', children: [] },
    { kind: 'source', id: 'source', name: '喜欢的音乐', instanceId: 'a', sourceId: 'likes' }
  ] }, { kind: 'group', id: 'other', name: '其他', children: [] }];
  expect(filterNodes(original, '喜欢')).toMatchObject([{ id: 'parent', children: [{ id: 'source', name: '喜欢的音乐' }] }]);
  expect(filterNodes(original, '常听')).toEqual([original[0]!]);
  expect(folderOptions(original, 'parent')).toEqual([{ value: 'other', title: '其他', children: [] }]);
  expect(moveToFolder(original, 'parent', 'child')).toBe(original);
});
