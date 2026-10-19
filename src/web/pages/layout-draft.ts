import type { LayoutNode } from '../../contracts/management';

export function findNode(nodes: LayoutNode[], id: string): LayoutNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === 'group') { const found = findNode(node.children, id); if (found) return found; }
  }
}
export function editNode(nodes: LayoutNode[], id: string, update: (node: LayoutNode) => LayoutNode | null): LayoutNode[] {
  return nodes.flatMap(node => {
    if (node.id === id) { const updated = update(node); return updated ? [updated] : []; }
    return [node.kind === 'group' ? { ...node, children: editNode(node.children, id, update) } : node];
  });
}
export function appendNode(nodes: LayoutNode[], parentId: string | null, node: LayoutNode): LayoutNode[] {
  return parentId === null ? [...nodes, node] : editNode(nodes, parentId, parent => parent.kind === 'group' ? { ...parent, children: [...parent.children, node] } : parent);
}
export type Placement = 'inside' | 'before' | 'after';
export function canMove(nodes: LayoutNode[], id: string, targetId: string, placement: Placement): boolean {
  const node = findNode(nodes, id); const target = findNode(nodes, targetId);
  return !!node && !!target && id !== targetId && !(node.kind === 'group' && findNode(node.children, targetId)) && (placement !== 'inside' || target.kind === 'group');
}
export function moveNode(nodes: LayoutNode[], id: string, targetId: string, placement: Placement): LayoutNode[] {
  if (!canMove(nodes, id, targetId, placement)) return nodes;
  const node = findNode(nodes, id)!; const remaining = editNode(nodes, id, () => null);
  if (placement === 'inside') return appendNode(remaining, targetId, node);
  const insert = (items: LayoutNode[]): LayoutNode[] => items.flatMap(item => item.id === targetId
    ? placement === 'before' ? [node, item] : [item, node]
    : [item.kind === 'group' ? { ...item, children: insert(item.children) } : item]);
  return insert(remaining);
}
