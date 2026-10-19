import { expect, test } from 'bun:test';
import type { LayoutNode } from '../src/contracts/management';
import { moveNode } from '../src/web/pages/layout-draft';

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
