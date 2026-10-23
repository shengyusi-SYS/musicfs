import type { LayoutNode } from '../../contracts/management';

export type LayoutDraft = { base: number; nodes: LayoutNode[] | null };

export function nodeTrail(nodes: LayoutNode[], id: string): LayoutNode[] | undefined {
  for (const node of nodes) {
    if (node.id === id) return [node];
    const child = node.kind === 'group' ? nodeTrail(node.children, id) : undefined;
    if (child) return [node, ...child];
  }
}

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
  return appendNodes(nodes, parentId, [node]);
}
export function appendNodes(nodes: LayoutNode[], parentId: string | null, additions: LayoutNode[]): LayoutNode[] {
  return parentId === null ? [...nodes, ...additions] : editNode(nodes, parentId, parent => parent.kind === 'group' ? { ...parent, children: [...parent.children, ...additions] } : parent);
}
export function locateNode(nodes: LayoutNode[], id: string, parentId: string | null = null): { node: LayoutNode; parentId: string | null; index: number; siblings: LayoutNode[] } | undefined {
  for (const [index, node] of nodes.entries()) {
    if (node.id === id) return { node, parentId, index, siblings: nodes };
    if (node.kind === 'group') { const found = locateNode(node.children, id, node.id); if (found) return found; }
  }
}
export function moveToFolder(nodes: LayoutNode[], id: string, parentId: string | null): LayoutNode[] {
  const found = locateNode(nodes, id);
  if (!found || found.parentId === parentId || parentId !== null && !canMove(nodes, id, parentId, 'inside')) return nodes;
  return appendNode(editNode(nodes, id, () => null), parentId, found.node);
}
export function filterNodes(nodes: LayoutNode[], query: string): LayoutNode[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return nodes;
  return nodes.flatMap(node => {
    if (node.name.toLocaleLowerCase().includes(needle)) return [node];
    if (node.kind !== 'group') return [];
    const children = filterNodes(node.children, needle);
    return children.length ? [{ ...node, children }] : [];
  });
}
export function groupIds(nodes: LayoutNode[]): string[] {
  return nodes.flatMap(node => node.kind === 'group' ? [node.id, ...groupIds(node.children)] : []);
}
export type FolderOption = { value: string; title: string; children?: FolderOption[] };
export function folderOptions(nodes: LayoutNode[], exclude?: string): FolderOption[] {
  return nodes.flatMap(node => node.kind === 'group' && node.id !== exclude
    ? [{ value: node.id, title: node.name, children: folderOptions(node.children, exclude) }] : []);
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
