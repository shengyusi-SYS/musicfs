import { useEffect, useState, type ReactNode } from 'react';
import { Button, Empty, Input, Tree } from 'antd';
import { ApiOutlined, FolderOutlined, LoadingOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQueries } from '@tanstack/react-query';
import type { SourceInstance } from '../../contracts/management';
import type { Api } from '../api';
import { exportedMusic, listingQuery, locationKey, sourceLocation, type MusicLocation } from './music-navigation';

type Branch = { key: string; title: ReactNode; icon?: ReactNode; location?: MusicLocation; children?: Branch[]; isLeaf?: boolean; selectable?: boolean };
export function MusicTree({ api, instances, selected, open }: { api: Api; instances: SourceInstance[]; selected: MusicLocation; open(location: MusicLocation): void }) {
  const [expanded, setExpanded] = useState<MusicLocation[]>([exportedMusic]);
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const [filter, setFilter] = useState('');
  const key = locationKey(selected);
  useEffect(() => {
    const additions = [...selected.ancestors.map((crumb, index) => ({ ...crumb, ancestors: selected.ancestors.slice(0, index) })), selected];
    setExpanded(current => [...new Map([...current, ...additions].map(value => [locationKey(value), value])).values()]);
    if (selected.target.kind === 'source') setSourcesOpen(true);
  }, [key]);
  const expandedIds = new Set(expanded.map(locationKey));
  const queries = useQueries({ queries: expanded.map(location => ({ ...listingQuery(api, location, instances),
    enabled: (location.target.kind !== 'source' || sourcesOpen) && location.ancestors.every(ancestor => expandedIds.has(locationKey(ancestor))) })) });
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
  function visible(node: Branch): Branch | null {
    const children = node.children?.flatMap(child => { const value = visible(child); return value ? [value] : []; });
    return !filter.trim() || node.location?.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()) || children?.length
      ? { ...node, ...(children ? { children } : {}) } : null;
  }
  const tree = [branch(exportedMusic), { key: 'sources', title: '音乐来源', selectable: false, children: instances.map(instance => branch(sourceLocation(instance))) }].flatMap(node => {
    const value = visible(node); return value ? [value] : [];
  });
  const expandedKeys = [...expanded.map(locationKey), ...(sourcesOpen ? ['sources'] : [])];
  return <><Input className="music-tree-filter" size="small" prefix={<SearchOutlined />} placeholder="筛选目录" aria-label="筛选目录树" allowClear value={filter} onChange={event => setFilter(event.target.value)} />
    <Tree<Branch> className="music-tree" aria-label="音乐库目录树" showIcon blockNode treeData={tree} selectedKeys={[key]}
      expandedKeys={filter ? [...expandedKeys, ...instances.map(sourceLocation).map(locationKey)] : expandedKeys} autoExpandParent={false}
      onSelect={(_keys, info) => { if (info.node.location) open(info.node.location); }}
      onExpand={(_keys, info) => {
        if (info.node.key === 'sources') { setSourcesOpen(info.expanded); return; }
        const location = info.node.location; if (!location) return;
        setExpanded(current => info.expanded ? [...current.filter(value => locationKey(value) !== locationKey(location)), location] : current.filter(value => locationKey(value) !== locationKey(location)));
        if (info.expanded) open(location);
      }} />
    {!tree.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的目录" />}
  </>;
}
