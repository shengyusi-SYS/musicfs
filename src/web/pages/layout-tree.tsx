import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Dropdown, Empty, Input, Modal, Tag, Tree, TreeSelect } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, EditOutlined, FolderAddOutlined, FolderOutlined, MoreOutlined, SearchOutlined, SwapOutlined } from '@ant-design/icons';
import type { LayoutNode, SourceInstance } from '../../contracts/management';
import { canMove, editNode, filterNodes, folderOptions, groupIds, locateNode, moveNode, moveToFolder } from './layout-draft';

type TreeNode = { key: string; title: ReactNode; icon: ReactNode; children?: TreeNode[]; draggable?: boolean; isLeaf?: boolean };
export function LayoutTree({ nodes, instances, selected, select, change, createFolder, disabled, expanded, setExpanded, renaming, setRenaming }: {
  nodes: LayoutNode[]; instances: SourceInstance[]; selected: string; select: (id: string) => void; change: (nodes: LayoutNode[]) => void;
  createFolder: (parentId: string | null) => void; disabled: boolean; expanded: string[] | null; setExpanded: (keys: string[]) => void;
  renaming: string | null; setRenaming: (id: string | null) => void;
}) {
  const [filter, setFilter] = useState(''); const [moving, setMoving] = useState<string | null>(null);
  useEffect(() => { if (renaming) setFilter(''); }, [renaming]);
  const locations = useMemo(() => {
    const result = new Map<string, NonNullable<ReturnType<typeof locateNode>>>();
    const visit = (siblings: LayoutNode[], parentId: string | null) => siblings.forEach((node, index) => {
      result.set(node.id, { node, parentId, index, siblings });
      if (node.kind === 'group') visit(node.children, node.id);
    });
    visit(nodes, null); return result;
  }, [nodes]);
  const visible = filterNodes(nodes, filter); const found = moving ? locations.get(moving) : undefined;
  function menu(node: LayoutNode) {
    const location = locations.get(node.id)!;
    return [
      ...(node.kind === 'group' ? [{ key: 'folder', label: '新建子文件夹', icon: <FolderAddOutlined aria-hidden="true" />, onClick: () => createFolder(node.id) }] : []),
      { key: 'rename', label: '重命名', icon: <EditOutlined aria-hidden="true" />, onClick: () => setRenaming(node.id) },
      { key: 'move', label: '移动到…', icon: <SwapOutlined aria-hidden="true" />, onClick: () => setMoving(node.id) },
      { key: 'up', label: '上移', icon: <ArrowUpOutlined aria-hidden="true" />, disabled: location.index === 0, onClick: () => change(moveNode(nodes, node.id, location.siblings[location.index - 1]!.id, 'before')) },
      { key: 'down', label: '下移', icon: <ArrowDownOutlined aria-hidden="true" />, disabled: location.index === location.siblings.length - 1, onClick: () => change(moveNode(nodes, node.id, location.siblings[location.index + 1]!.id, 'after')) },
      { key: 'remove', label: '移除', danger: true, icon: <DeleteOutlined aria-hidden="true" />, onClick: () => { change(editNode(nodes, node.id, () => null)); select(location.parentId ?? ''); } }
    ];
  }
  const tree = (items: LayoutNode[]): TreeNode[] => items.map(node => {
    const original = locations.get(node.id)!.node;
    return { key: node.id, icon: <FolderOutlined aria-hidden="true" />,
    title: <span className="layout-node">
      {renaming === node.id ? <RenameNode key={node.id} name={node.name} commit={name => { change(editNode(nodes, node.id, item => ({ ...item, name }))); setRenaming(null); }} cancel={() => setRenaming(null)} />
        : <><span className="layout-node-name" onDoubleClick={event => { if (!disabled) { event.stopPropagation(); setRenaming(node.id); } }}>{node.name}</span>
          <span className="layout-node-detail">{original.kind === 'group' ? original.children.length + ' 项' : instances.find(instance => instance.id === original.instanceId)?.name ?? <Tag>来源已删除</Tag>}</span>
          <span onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}><Dropdown trigger={['click']} menu={{ items: menu(node) }} disabled={disabled}>
            <Button size="small" type="text" className="layout-node-menu" icon={<MoreOutlined aria-hidden="true" />} aria-label={node.name + '的操作'} />
          </Dropdown></span></>}
    </span>, ...(node.kind === 'group' ? { children: tree(node.children) } : { isLeaf: true }) }; });
  return <>
    <Input className="layout-tree-search" prefix={<SearchOutlined aria-hidden="true" />} aria-label="搜索播放器目录" placeholder="查找目录" allowClear value={filter} onChange={event => setFilter(event.target.value)} />
    <div className="layout-tree-body">
      <Tree<TreeNode> showIcon blockNode treeData={[{ key: '', title: <span className="layout-root-title">全部音乐</span>, icon: <FolderOutlined aria-hidden="true" />, draggable: false, children: tree(visible) }]}
        disabled={disabled} draggable={!filter.trim() && renaming === null ? { nodeDraggable: node => node.key !== '' } : false}
        selectedKeys={[selected]} expandedKeys={filter.trim() ? ['', ...groupIds(visible)] : expanded ?? ['', ...groupIds(nodes)]} autoExpandParent={false}
        onExpand={keys => setExpanded(keys.map(String))} onSelect={keys => { if (keys.length) select(String(keys[0])); }}
        allowDrop={({ dragNode, dropNode, dropPosition }) => dropNode.key === '' ? dropPosition === 0 : canMove(nodes, String(dragNode.key), String(dropNode.key), dropPosition === 0 ? 'inside' : dropPosition < 0 ? 'before' : 'after')}
        onDrop={info => {
          const id = String(info.dragNode.key); const target = String(info.node.key);
          const position = info.dropPosition - Number(info.node.pos.split('-').at(-1));
          change(target === '' ? moveToFolder(nodes, id, null) : moveNode(nodes, id, target, !info.dropToGap ? 'inside' : position < 0 ? 'before' : 'after'));
          if (!info.dropToGap) setExpanded([...new Set(['', ...(expanded ?? groupIds(nodes)), target])]);
        }} />
      {!visible.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filter ? '没有匹配的目录' : '选择音乐内容，或新建文件夹'} />}
    </div>
    {found && <MoveFolder key={found.node.id} name={found.node.name} current={found.parentId} nodes={nodes} exclude={found.node.id} close={() => setMoving(null)} move={parentId => {
      change(moveToFolder(nodes, found.node.id, parentId)); setExpanded([...new Set(['', ...(expanded ?? groupIds(nodes)), parentId ?? ''])]); setMoving(null);
    }} />}
  </>;
}

function RenameNode({ name, commit, cancel }: { name: string; commit: (name: string) => void; cancel: () => void }) {
  const [value, setValue] = useState(name); const valid = !!value.trim();
  return <span className="layout-rename" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <Input aria-label="目录名称" autoFocus defaultValue={name} maxLength={500} onFocus={event => event.target.select()} onChange={event => setValue(event.target.value)}
      onBlur={() => valid ? commit(value.trim()) : cancel()} onKeyDown={event => { if (event.key === 'Enter' && valid) commit(value.trim()); if (event.key === 'Escape') cancel(); }} />
    <Button type="text" size="small" icon={<CheckOutlined aria-hidden="true" />} aria-label="确认名称" disabled={!valid} onMouseDown={event => event.preventDefault()} onClick={() => commit(value.trim())} />
    <Button type="text" size="small" icon={<CloseOutlined aria-hidden="true" />} aria-label="取消改名" onMouseDown={event => event.preventDefault()} onClick={cancel} />
  </span>;
}
function MoveFolder({ name, current, nodes, exclude, close, move }: { name: string; current: string | null; nodes: LayoutNode[]; exclude: string; close: () => void; move: (id: string | null) => void }) {
  const [destination, setDestination] = useState(current ?? '');
  return <Modal title={'移动「' + name + '」'} open onCancel={close} okText="移动" cancelText="取消" okButtonProps={{ disabled: destination === (current ?? '') }} onOk={() => move(destination || null)}>
    <div className="field-block"><label htmlFor="layout-move-target">目标文件夹</label><TreeSelect id="layout-move-target" value={destination} onChange={setDestination} treeDefaultExpandAll showSearch treeNodeFilterProp="title"
      treeData={[{ value: '', title: '全部音乐', children: folderOptions(nodes, exclude) }]} /></div>
  </Modal>;
}
