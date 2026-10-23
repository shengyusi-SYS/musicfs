import { useState } from 'react';
import { Button, Dropdown, type MenuProps } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EditOutlined, FolderAddOutlined, MoreOutlined, SwapOutlined } from '@ant-design/icons';
import type { LayoutNode } from '../../contracts/management';
import { appendNodes, editNode, locateNode, moveNode } from '../pages/layout-draft';
import { layoutLocation, type MusicLocation } from './music-navigation';
import type { LibraryLayout } from './use-library-layout';

export function useLayoutActions(layout: LibraryLayout, open: (location: MusicLocation) => void, showTree: () => void) {
  const [renaming, setRenaming] = useState<string | null>(null); const [moving, setMoving] = useState<string | null>(null);
  const nodes = layout.nodes ?? [];
  function reveal() { if (matchMedia('(max-width: 880px)').matches) showTree(); }
  function createFolder(parent: string | null) {
    const node = layout.createFolder(parent);
    if (node) { open(layoutLocation(appendNodes(nodes, parent, [node]), node.id)); setRenaming(node.id); reveal(); }
  }
  function rename(node: LayoutNode) { open(layoutLocation(nodes, node.id)); setRenaming(node.id); reveal(); }
  function menu(node: LayoutNode): NonNullable<MenuProps['items']> {
    const location = locateNode(nodes, node.id)!;
    return [
      ...(node.kind === 'group' ? [{ key: 'folder', label: '新建子文件夹', icon: <FolderAddOutlined />, onClick: () => createFolder(node.id) }] : []),
      { key: 'rename', label: '重命名', icon: <EditOutlined />, onClick: () => rename(node) },
      { key: 'move', label: '移动到…', icon: <SwapOutlined />, onClick: () => setMoving(node.id) },
      { key: 'up', label: '上移', icon: <ArrowUpOutlined />, disabled: location.index === 0, onClick: () => layout.change(moveNode(nodes, node.id, location.siblings[location.index - 1]!.id, 'before')) },
      { key: 'down', label: '下移', icon: <ArrowDownOutlined />, disabled: location.index === location.siblings.length - 1, onClick: () => layout.change(moveNode(nodes, node.id, location.siblings[location.index + 1]!.id, 'after')) },
      { key: 'remove', label: '移除', danger: true, icon: <DeleteOutlined />, onClick: () => {
        layout.change(editNode(nodes, node.id, () => null)); open(layoutLocation(nodes, location.parentId ?? ''));
      } }
    ];
  }
  function button(node: LayoutNode) {
    return <span className="music-node-actions" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}><Dropdown trigger={['click']} menu={{ items: menu(node) }} disabled={layout.disabled}>
      <Button size="small" type="text" className="music-node-menu" icon={<MoreOutlined />} aria-label={node.name + '的操作'} />
    </Dropdown></span>;
  }
  return { renaming, setRenaming, moving, setMoving, createFolder, rename, menu, button };
}
export type LayoutActions = ReturnType<typeof useLayoutActions>;
