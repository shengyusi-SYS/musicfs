import { t } from '../i18n';
import { useState } from 'react';
import { Button, Dropdown, type MenuProps } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EditOutlined, FolderAddOutlined, MoreOutlined, SwapOutlined } from '@ant-design/icons';
import type { LayoutNode } from '../../contracts/management';
import { appendNodes, editNode, locateNode, moveNode } from '../pages/layout-draft';
import { layoutLocation, type MusicLocation } from './music-navigation';
import type { LibraryLayout } from './use-library-layout';

export function useLayoutActions(layout: LibraryLayout, current: MusicLocation, open: (location: MusicLocation) => void, showTree: () => void) {
  const [renaming, setRenaming] = useState<string | null>(null); const [moving, setMoving] = useState<string | null>(null);
  const nodes = layout.nodes ?? [];
  function reveal() { showTree(); }
  function createFolder(parent: string | null) {
    const node = layout.createFolder(parent);
    if (node) { if (current.target.kind !== 'source') open(layoutLocation(appendNodes(nodes, parent, [node]), node.id)); setRenaming(node.id); reveal(); }
  }
  function rename(node: LayoutNode) { setRenaming(node.id); reveal(); }
  function menu(node: LayoutNode): NonNullable<MenuProps['items']> {
    const location = locateNode(nodes, node.id)!;
    return [
      ...(node.kind === 'group' ? [{ key: 'folder', label: t("新建子文件夹"), icon: <FolderAddOutlined />, onClick: () => createFolder(node.id) }] : []),
      { key: 'rename', label: t("重命名"), icon: <EditOutlined />, onClick: () => rename(node) },
      { key: 'move', label: t("移动到…"), icon: <SwapOutlined />, onClick: () => setMoving(node.id) },
      { key: 'up', label: t("上移"), icon: <ArrowUpOutlined />, disabled: location.index === 0, onClick: () => layout.change(moveNode(nodes, node.id, location.siblings[location.index - 1]!.id, 'before')) },
      { key: 'down', label: t("下移"), icon: <ArrowDownOutlined />, disabled: location.index === location.siblings.length - 1, onClick: () => layout.change(moveNode(nodes, node.id, location.siblings[location.index + 1]!.id, 'after')) },
      { key: 'remove', label: t("移除"), danger: true, icon: <DeleteOutlined />, onClick: () => {
        layout.change(editNode(nodes, node.id, () => null)); if (current.target.kind !== 'source') open(layoutLocation(nodes, location.parentId ?? ''));
      } }
    ];
  }
  function button(node: LayoutNode) {
    return <span className="music-node-actions" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}><Dropdown trigger={['click']} menu={{ items: menu(node) }} disabled={layout.disabled}>
      <Button size="small" type="text" className="music-node-menu" icon={<MoreOutlined />} aria-label={node.name + t("的操作")} />
    </Dropdown></span>;
  }
  return { renaming, setRenaming, moving, setMoving, createFolder, rename, menu, button };
}
export type LayoutActions = ReturnType<typeof useLayoutActions>;
