import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Empty, Input, Tree, Tooltip } from 'antd';
import { ApiOutlined, FolderAddOutlined, FolderOutlined, LoadingOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQueries } from '@tanstack/react-query';
import type { LayoutNode, SourceInstance } from '../../contracts/management';
import type { Api } from '../api';
import { exportedMusic, layoutLocation, locationKey, sourceLocation, type MusicLocation } from './music-navigation';
import { listingQuery, layoutSource, rootsQuery, sourceDirectory, type SourceRoot } from './music-listing';
import { canMove, editNode, groupIds, locateNode, moveNode, moveToFolder, type Placement } from '../pages/layout-draft';
import type { LibraryLayout } from './use-library-layout';
import type { LayoutActions } from './use-layout-actions';
import { RenameNode } from './music-layout-controls';
import { MusicDropTarget, MusicLayoutDrag, MusicSourceDrag, sourceDrag, type SourceDrag } from './music-drag';

type Branch = { key: string; title: ReactNode; icon?: ReactNode; location?: MusicLocation; children?: Branch[]; isLeaf?: boolean; selectable?: boolean };
export type MusicTreeView = { expanded: MusicLocation[]; filter: string; location: MusicLocation | null };
export function MusicTree({ api, instances, selected, open, layout, actions, section, views, add, reveal, options }: {
  api: Api; instances: SourceInstance[]; selected: MusicLocation; open(location: MusicLocation, keepTree?: boolean): void;
  layout: LibraryLayout; actions: LayoutActions; section: 'sources' | 'layout'; add(data: SourceDrag, parentId: string | null): void;
  views: Map<string, MusicTreeView>;
  reveal: MusicLocation | null; options?: ReactNode;
}) {
  const [expanded, setExpanded] = useState<MusicLocation[]>(() => views.get(section)?.expanded ?? (section === 'layout' ? [exportedMusic] : []));
  const [filter, setFilter] = useState(() => views.get(section)?.filter ?? ''); const nodes = layout.nodes ?? [];
  const relevant = section === 'sources' ? selected.target.kind === 'source' : selected.target.kind === 'layout';
  const lastLocation = useRef<MusicLocation | null>(views.get(section)?.location ?? null); if (relevant) lastLocation.current = selected;
  const key = lastLocation.current ? locationKey(lastLocation.current) : '';
  useEffect(() => { views.set(section, { expanded, filter, location: lastLocation.current }); }, [views, section, expanded, filter, key]);
  useEffect(() => {
    if (section !== 'layout' || !actions.renaming) return;
    setFilter(''); const location = layoutLocation(nodes, actions.renaming); lastLocation.current = location; revealNode(location);
  }, [actions.renaming, section]);
  function expand(location: MusicLocation) {
    const additions = [...location.ancestors.map((crumb, index) => ({ ...crumb, ancestors: location.ancestors.slice(0, index) })), location];
    setExpanded(current => [...new Map([...current, ...additions].map(value => [locationKey(value), value])).values()]);
  }
  function revealNode(location: MusicLocation) {
    const parent = location.ancestors.at(-1);
    if (parent) expand({ ...parent, ancestors: location.ancestors.slice(0, -1) });
  }
  useEffect(() => { if (relevant) expand(selected); }, [key]);
  useEffect(() => { if (section === 'layout' && reveal) expand(reveal); }, [reveal]);
  const expandedIds = new Set(expanded.map(locationKey));
  const visibleExpanded = expanded.filter(location => location.ancestors.every(ancestor => expandedIds.has(locationKey(ancestor))));
  const rootInstances = instances.filter(instance => visibleExpanded.some(location => layoutSource(nodes, location)?.instanceId === instance.id || location.target.kind === 'source' && location.target.instanceId === instance.id && location.target.directoryRef === undefined));
  const rootQueries = useQueries({ queries: rootInstances.map(instance => rootsQuery(api, instance)) });
  const roots = new Map<string, SourceRoot[] | undefined>(rootInstances.map((instance, index) => [instance.id, rootQueries[index]?.data]));
  const queries = useQueries({ queries: expanded.map(location => {
    const instanceId = location.target.kind === 'source' ? location.target.instanceId : layoutSource(nodes, location)?.instanceId;
    const query = listingQuery(api, location, instances, nodes, instanceId ? roots.get(instanceId) : undefined);
    return { ...query, enabled: query.enabled && location.ancestors.every(ancestor => expandedIds.has(locationKey(ancestor))) };
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
    const target = location.target;
    const instanceId = target.kind === 'source' ? target.instanceId : layoutSource(nodes, location)?.instanceId;
    const root = instanceId ? sourceDirectory(location, roots.get(instanceId), nodes) : undefined;
    return { key: locationKey(location), location, title: <MusicSourceDrag data={root && instanceId && !layout.disabled ? sourceDrag(instanceId, [root]) : undefined}>
      <span className="music-tree-name" title={location.name}>{location.name}</span></MusicSourceDrag>,
      icon: value?.isFetching ? <LoadingOutlined /> : location.target.kind === 'source' && location.target.directoryRef === undefined ? <ApiOutlined /> : <FolderOutlined />,
      ...(children ? { children, isLeaf: !children.length && !value?.isError } : {}) };
  }
  function move(id: string, target: string, placement: Placement) {
    const next = target === '' ? moveToFolder(nodes, id, null) : moveNode(nodes, id, target, placement);
    layout.change(next); lastLocation.current = layoutLocation(next, id);
    revealNode(layoutLocation(next, id));
  }
  function layoutBranch(node: LayoutNode): Branch {
    const location = layoutLocation(nodes, node.id);
    const result = node.kind === 'source' ? branch(location) : { key: locationKey(location), location, icon: <FolderOutlined />, children: node.children.map(layoutBranch) };
    const title = <MusicLayoutDrag data={!layout.disabled && !filter.trim() && !actions.renaming ? { type: 'music-layout', nodeId: node.id, name: node.name } : undefined}><span className="music-tree-row">
      {actions.renaming === node.id ? <RenameNode key={node.id} name={node.name} commit={name => { layout.change(editNode(nodes, node.id, item => ({ ...item, name }))); actions.setRenaming(null); }} cancel={() => actions.setRenaming(null)} />
        : <><span className="music-tree-name" title={node.name} onDoubleClick={event => { event.stopPropagation(); if (!layout.disabled) actions.rename(node); }}>{node.name}</span>{actions.button(node)}</>}
    </span></MusicLayoutDrag>;
    return { ...result, title: <MusicDropTarget disabled={layout.disabled || !!actions.renaming} name={node.name} folder={node.kind === 'group'} add={data => add(data, node.id)} canMove={(id, placement) => canMove(nodes, id, node.id, placement)} move={(id, placement) => move(id, node.id, placement)}>{title}</MusicDropTarget> };
  }
  function visible(node: Branch): Branch | null {
    const children = node.children?.flatMap(child => { const value = visible(child); return value ? [value] : []; });
    return !filter.trim() || node.location?.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()) || children?.length
      ? { ...node, ...(children ? { children } : {}) } : null;
  }
  const playerRoot: Branch = { key: locationKey(exportedMusic), location: exportedMusic, title: <MusicDropTarget disabled={layout.disabled || !!actions.renaming} name="播放器目录" folder root add={data => add(data, null)} canMove={id => !!locateNode(nodes, id)} move={id => move(id, '', 'inside')}>全部音乐</MusicDropTarget>,
    icon: <FolderOutlined />, children: nodes.map(layoutBranch) };
  const tree = (section === 'layout' ? [playerRoot] : instances.map(instance => branch(sourceLocation(instance)))).flatMap(node => {
    const value = visible(node); return value ? [value] : [];
  });
  const expandedKeys = expanded.map(locationKey);
  const target = lastLocation.current?.target; const selection = target?.kind === 'layout' ? locateNode(nodes, target.nodeId) : undefined;
  const parentId = selection?.node.kind === 'group' ? selection.node.id : selection?.parentId ?? null;
  return <section className={'music-tree-pane music-tree-' + section} aria-label={section === 'layout' ? '播放器目录' : '音乐来源导航'}>
    <header className="music-pane-heading"><h2>{section === 'layout' ? '播放器目录' : '音乐来源'}</h2>
      <span>{section === 'layout' && <Tooltip title="新建文件夹"><Button type="text" size="small" icon={<FolderAddOutlined />} aria-label="新建播放器文件夹" disabled={layout.disabled} onClick={() => actions.createFolder(parentId)} /></Tooltip>}{options}</span>
    </header>
    <Input className="music-tree-filter" size="small" prefix={<SearchOutlined />} placeholder="筛选目录" aria-label={section === 'layout' ? '筛选播放器目录' : '筛选来源目录'} allowClear value={filter} onChange={event => setFilter(event.target.value)} />
    <Tree<Branch> className="music-tree" aria-label={section === 'layout' ? '播放器目录树' : '来源目录树'} showIcon blockNode treeData={tree} selectedKeys={[key]}
      expandedKeys={filter ? [...expandedKeys, ...instances.map(sourceLocation).map(locationKey), ...groupIds(nodes).map(id => locationKey(layoutLocation(nodes, id)))] : expandedKeys} autoExpandParent={false}
      onSelect={(_keys, info) => { if (info.node.location) open(info.node.location); }}
      onExpand={(_keys, info) => {
        const location = info.node.location; if (!location) return;
        setExpanded(current => info.expanded ? [...current.filter(value => locationKey(value) !== locationKey(location)), location] : current.filter(value => locationKey(value) !== locationKey(location)));
        if (info.expanded && section === 'sources') open(location, true);
      }} />
    {!tree.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={section === 'sources' && !instances.length ? '尚未添加来源' : '没有匹配的目录'} />}
  </section>;
}
