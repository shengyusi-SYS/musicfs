import { useEffect, useState, type ReactNode } from 'react';
import { Button, Empty, Input, Tree } from 'antd';
import { ApiOutlined, FolderOutlined, LoadingOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQueries } from '@tanstack/react-query';
import type { LayoutNode, SourceInstance } from '../../contracts/management';
import type { Api } from '../api';
import { exportedMusic, layoutLocation, locationKey, sourceLocation, type MusicLocation } from './music-navigation';
import { listingQuery, layoutSource, rootsQuery, type SourceRoot } from './music-listing';
import { canMove, editNode, groupIds, moveNode, moveToFolder } from '../pages/layout-draft';
import type { LibraryLayout } from './use-library-layout';
import type { LayoutActions } from './use-layout-actions';
import { RenameNode } from './music-layout-controls';

type Branch = { key: string; title: ReactNode; icon?: ReactNode; location?: MusicLocation; children?: Branch[]; isLeaf?: boolean; selectable?: boolean; layoutId?: string };
export function MusicTree({ api, instances, selected, open, layout, actions }: { api: Api; instances: SourceInstance[]; selected: MusicLocation; open(location: MusicLocation, keepTree?: boolean): void; layout: LibraryLayout; actions: LayoutActions }) {
  const [expanded, setExpanded] = useState<MusicLocation[]>([exportedMusic]);
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const [filter, setFilter] = useState('');
  const key = locationKey(selected); const nodes = layout.nodes ?? [];
  useEffect(() => { if (actions.renaming) setFilter(''); }, [actions.renaming]);
  useEffect(() => {
    const additions = [...selected.ancestors.map((crumb, index) => ({ ...crumb, ancestors: selected.ancestors.slice(0, index) })), selected];
    setExpanded(current => [...new Map([...current, ...additions].map(value => [locationKey(value), value])).values()]);
    if (selected.target.kind === 'source') setSourcesOpen(true);
  }, [key]);
  const expandedIds = new Set(expanded.map(locationKey));
  const rootInstances = instances.filter(instance => expanded.some(location => layoutSource(nodes, location)?.instanceId === instance.id));
  const rootQueries = useQueries({ queries: rootInstances.map(instance => rootsQuery(api, instance)) });
  const roots = new Map<string, SourceRoot[] | undefined>(rootInstances.map((instance, index) => [instance.id, rootQueries[index]?.data]));
  const queries = useQueries({ queries: expanded.map(location => {
    const source = layoutSource(nodes, location); const query = listingQuery(api, location, instances, nodes, source ? roots.get(source.instanceId) : undefined);
    return { ...query, enabled: query.enabled && (location.target.kind !== 'source' || sourcesOpen) && location.ancestors.every(ancestor => expandedIds.has(locationKey(ancestor))) };
  }) });
  const results = new Map(expanded.map((location, index) => [locationKey(location), queries[index]!]));
  function branch(location: MusicLocation, parents = new Set<string>()): Branch {
    if (parents.has(locationKey(location))) return { key: locationKey(location) + ':link', location, title: location.name, isLeaf: true, icon: <FolderOutlined /> };
    const visited = new Set([...parents, locationKey(location)]);
    const value = results.get(locationKey(location));
    const children: Branch[] = value?.data?.entries.flatMap(entry => entry.location ? [branch(entry.location, visited)] : [])
      ?? [{ key: locationKey(location) + ':loading', title: value?.isError ? '未能加载' : '加载中…', selectable: false, isLeaf: true }];
    if (value?.isError) children.push({ key: locationKey(location) + ':retry', selectable: false, isLeaf: true,
      title: <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => { open(location); void value.refetch(); }}>重新加载</Button> });
    return { key: locationKey(location), location, title: <span className="music-tree-name" title={location.name}>{location.name}</span>,
      icon: value?.isFetching ? <LoadingOutlined /> : location.target.kind === 'source' && location.target.directoryRef === undefined ? <ApiOutlined /> : <FolderOutlined />,
      ...(children ? { children, isLeaf: !children.length && !value?.isError } : {}) };
  }
  function layoutBranch(node: LayoutNode): Branch {
    const location = layoutLocation(nodes, node.id);
    const result = node.kind === 'source' ? branch(location) : { key: locationKey(location), location, icon: <FolderOutlined />, children: node.children.map(layoutBranch) };
    return { ...result, layoutId: node.id, title: <span className="music-tree-row">
      {actions.renaming === node.id ? <RenameNode key={node.id} name={node.name} commit={name => { layout.change(editNode(nodes, node.id, item => ({ ...item, name }))); actions.setRenaming(null); }} cancel={() => actions.setRenaming(null)} />
        : <><span className="music-tree-name" title={node.name} onDoubleClick={event => { event.stopPropagation(); if (!layout.disabled) actions.rename(node); }}>{node.name}</span>{actions.button(node)}</>}
    </span> };
  }
  function visible(node: Branch): Branch | null {
    const children = node.children?.flatMap(child => { const value = visible(child); return value ? [value] : []; });
    return !filter.trim() || node.location?.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()) || children?.length
      ? { ...node, ...(children ? { children } : {}) } : null;
  }
  const tree = [{ key: locationKey(exportedMusic), location: exportedMusic, title: '播放器目录', icon: <FolderOutlined />, layoutId: '', children: nodes.map(layoutBranch) }, { key: 'sources', title: '音乐来源', selectable: false, children: instances.map(instance => branch(sourceLocation(instance))) }].flatMap(node => {
    const value = visible(node); return value ? [value] : [];
  });
  const expandedKeys = [...expanded.map(locationKey), ...(sourcesOpen ? ['sources'] : [])];
  return <><Input className="music-tree-filter" size="small" prefix={<SearchOutlined />} placeholder="筛选目录" aria-label="筛选目录树" allowClear value={filter} onChange={event => setFilter(event.target.value)} />
    <Tree<Branch> className="music-tree" aria-label="音乐库目录树" showIcon blockNode treeData={tree} selectedKeys={[key]}
      expandedKeys={filter ? [...expandedKeys, ...instances.map(sourceLocation).map(locationKey), ...groupIds(nodes).map(id => locationKey(layoutLocation(nodes, id)))] : expandedKeys} autoExpandParent={false}
      draggable={!layout.disabled && !filter.trim() && !actions.renaming ? { icon: false, nodeDraggable: node => !!(node as Branch).layoutId } : false}
      allowDrop={({ dragNode, dropNode, dropPosition }) => !!dragNode.layoutId && dropNode.layoutId !== undefined && (dropNode.layoutId === '' ? dropPosition === 0 : canMove(nodes, dragNode.layoutId, dropNode.layoutId, dropPosition === 0 ? 'inside' : dropPosition < 0 ? 'before' : 'after'))}
      onDrop={info => {
        const id = info.dragNode.layoutId!; const target = info.node.layoutId!;
        const position = info.dropPosition - Number(info.node.pos.split('-').at(-1));
        const next = target === '' ? moveToFolder(nodes, id, null) : moveNode(nodes, id, target, !info.dropToGap ? 'inside' : position < 0 ? 'before' : 'after');
        layout.change(next); open(layoutLocation(next, id));
      }}
      onSelect={(_keys, info) => { if (info.node.location) open(info.node.location); }}
      onExpand={(_keys, info) => {
        if (info.node.key === 'sources') { setSourcesOpen(info.expanded); return; }
        const location = info.node.location; if (!location) return;
        setExpanded(current => info.expanded ? [...current.filter(value => locationKey(value) !== locationKey(location)), location] : current.filter(value => locationKey(value) !== locationKey(location)));
        if (info.expanded) open(location, true);
      }} />
    {!tree.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的目录" />}
  </>;
}
