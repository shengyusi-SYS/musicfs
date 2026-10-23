import { useMemo, useState } from 'react';
import { Alert, Breadcrumb, Button, Empty, Input, Skeleton, Space, Table, Typography } from 'antd';
import { FileOutlined, FolderOutlined, HolderOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { LayoutNode, SourceInstance } from '../../contracts/management';
import type { Api } from '../api';
import { Failure } from './feedback';
import { pendingRefreshId, RefreshProgress, usePersistentRefresh } from './refresh';
import { locationKey, type MusicEntry, type MusicLocation } from './music-navigation';
import { useMusicListing, type MusicListing, type SourceRoot } from './music-listing';
import { findNode } from '../pages/layout-draft';
import type { LayoutActions } from './use-layout-actions';
import { MusicDragRow, MusicSourceDrag, sourceDrag } from './music-drag';

export function MusicBrowser({ api, instances, location, open, actions, login, nodes, layoutActions, add, editingDisabled }: {
  api: Api; instances: SourceInstance[]; location: MusicLocation; open(location: MusicLocation): void;
  actions(source: NonNullable<MusicListing['source']>, authentication: boolean, metadata: { disabled: boolean; run(): void } | null): React.ReactNode;
  login(instance: SourceInstance): void; nodes: LayoutNode[]; layoutActions: LayoutActions; add(instance: SourceInstance, roots: SourceRoot[]): void; editingDisabled: boolean;
}) {
  const [filter, setFilter] = useState('');
  const listing = useMusicListing(api, location, instances, nodes);
  const [selected, setSelected] = useState<React.Key[]>([]);
  const source = listing.source;
  const instance = instances.find(value => value.id === source?.instanceId);
  const configuration = useQuery({ queryKey: ['configuration', source?.pluginId], enabled: !!source?.pluginId, queryFn: ({ signal }) => api.configuration(source!.pluginId, signal) });
  const pending = pendingRefreshId(listing.error);
  const refresh = usePersistentRefresh(api, { instanceId: source?.instanceId, operationId: pending });
  const busy = refresh.active || refresh.starting || refresh.preparing;
  const reauthorize = instance && configuration.data?.authentication ? () => login(instance) : undefined;
  const entries = useMemo(() => listing.data?.entries.filter(entry => entry.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())) ?? [], [listing.data, filter]);
  const layoutNode = location.target.kind === 'layout' && location.target.directoryRef === undefined ? findNode(nodes, location.target.nodeId) : undefined;
  const editableListing = location.target.kind === 'layout' && (location.target.nodeId === '' || layoutNode?.kind === 'group');
  const sourceRoot = location.target.kind === 'source' && location.target.directoryRef !== undefined ? listing.roots?.find(root => root.directoryRef === (location.target.kind === 'source' ? location.target.directoryRef : undefined)) : undefined;
  const selectingRoots = location.target.kind === 'source' && location.target.directoryRef === undefined && !!listing.roots?.length;
  function entryRoot(entry: MusicEntry) { const target = entry.location?.target; return target?.kind === 'source' ? listing.roots?.find(root => root.directoryRef === target.directoryRef) : undefined; }
  const selectedRoots = listing.data?.entries.flatMap(entry => selected.includes(entry.location ? locationKey(entry.location) : entry.name) && entryRoot(entry) ? [entryRoot(entry)!] : []) ?? [];
  const crumbs = [...location.ancestors, location];
  function crumbName(crumb: typeof crumbs[number]) {
    const target = crumb.target;
    return target.kind === 'source' && target.directoryRef === undefined ? instances.find(value => value.id === target.instanceId)?.name ?? crumb.name : crumb.name;
  }
  return <section className="music-content" aria-label="音乐内容">
    <div className={'music-breadcrumb' + (!location.ancestors.length ? ' music-breadcrumb-root' : '')}>
      {!!location.ancestors.length && <Breadcrumb items={crumbs.map((crumb, index) => ({ title: index === crumbs.length - 1 ? crumbName(crumb) : <button className="text-button" onClick={() => open({ ...crumb, ancestors: crumbs.slice(0, index) })}>{crumbName(crumb)}</button> }))} />}
    </div>
    <header className="music-content-heading"><div><Typography.Title level={2}><MusicSourceDrag data={sourceRoot && instance && !editingDisabled ? sourceDrag(instance.id, [sourceRoot]) : undefined}>
        {sourceRoot && <HolderOutlined className="music-title-drag-handle" />}{location.target.kind === 'source' && location.target.directoryRef === undefined ? instance?.name ?? location.name : location.name}</MusicSourceDrag></Typography.Title>
      <div className="music-content-meta">{listing.data ? `${listing.data.entries.length.toLocaleString()} 项` : listing.isPending ? '正在载入' : ''}
        {listing.data?.status?.completedAt && ` · 更新于 ${new Date(listing.data.status.completedAt).toLocaleString()}`}</div></div>
      <Space wrap>{layoutNode && layoutActions.button(layoutNode)}{sourceRoot && instance && <Button icon={<PlusOutlined />} disabled={editingDisabled} onClick={() => add(instance, [sourceRoot])}>添加到…</Button>}{source && <>{(listing.data?.status?.pendingFileInfo ?? 0) > 0 && <Button disabled={busy} onClick={() => refresh.start({ kind: 'file-info', directoryRef: source.directoryRef! })}>准备文件</Button>}
        <Button icon={<ReloadOutlined />} loading={busy} onClick={() => refresh.start(source.directoryRef === undefined ? { kind: 'instance' } : { kind: 'directory', directoryRef: source.directoryRef })}>更新</Button>
        {actions(source, !!configuration.data?.authentication, configuration.data?.metadataRefresh && source.directoryRef !== undefined && listing.data?.entries.some(entry => entry.kind === 'file')
          ? { disabled: busy, run: () => refresh.start({ kind: 'metadata', directoryRef: source.directoryRef! }) } : null)}
      </>}</Space>
    </header>
    <div className="music-content-feedback"><Failure error={pending ? null : listing.error} retry={() => void listing.refetch()} reauthorize={reauthorize} />
      <RefreshProgress operation={refresh} labels={configuration.data?.statistics} reload={() => refresh.view && refresh.start(refresh.view.scope)} reauthorize={reauthorize} />
      {listing.data?.status?.error && !refresh.active && <Alert className="feedback" type="warning" showIcon title="上次更新未完成" action={<Button size="small" onClick={() => refresh.start({ kind: 'directory', directoryRef: source!.directoryRef! })}>重试</Button>} />}
    </div>
    <div className="music-list-toolbar"><Input prefix={<SearchOutlined />} placeholder="搜索当前目录" aria-label="搜索当前目录" allowClear value={filter} onChange={event => setFilter(event.target.value)} />
      {selectedRoots.length > 0 && instance ? <Button disabled={editingDisabled} onClick={() => add(instance, selectedRoots)}>添加 {selectedRoots.length} 项到…</Button> : filter && <Typography.Text type="secondary">{entries.length} 项</Typography.Text>}
    </div>
    {listing.isPending ? <Skeleton className="music-list-loading" active paragraph={{ rows: 6 }} /> : listing.data && <Table<MusicEntry> className="music-file-table" size="middle" dataSource={entries} components={{ body: { row: MusicDragRow } }}
      onRow={entry => {
        const root = entryRoot(entry); const chosen = selectedRoots.some(item => item.sourceId === root?.sourceId) ? selectedRoots : root ? [root] : [];
        return { className: '', dragData: !editingDisabled && instance && chosen.length ? sourceDrag(instance.id, chosen) : undefined };
      }}
      {...(selectingRoots ? { rowSelection: { selectedRowKeys: selected, preserveSelectedRowKeys: true, onChange: setSelected, getCheckboxProps: (entry: MusicEntry) => ({ disabled: editingDisabled || !entryRoot(entry), 'aria-label': '选择' + entry.name }) } } : {})}
      rowKey={entry => entry.location ? locationKey(entry.location) : entry.name} scroll={{ y: '100%' }} pagination={{ pageSize: 50, hideOnSinglePage: true, showSizeChanger: false, simple: true }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filter ? '没有匹配的名称' : '此目录为空'}>
        {!filter && location.target.kind === 'layout' && <Button onClick={() => layoutActions.createFolder(layoutNode?.kind === 'group' ? layoutNode.id : null)} disabled={editingDisabled}>新建文件夹</Button>}
      </Empty> }} columns={[
        { title: '名称', key: 'name', render: (_value, entry) => entry.location
          ? <button className="music-folder-link" onClick={() => open(entry.location!)}><FolderOutlined /><span>{entry.name}</span></button>
          : <span className="music-file-name"><FileOutlined /><span>{entry.name}</span></span> },
        ...(editableListing ? [{ title: '', key: 'actions', width: 48, render: (_value: unknown, entry: MusicEntry) => {
          const target = entry.location?.target; const node = target?.kind === 'layout' && target.directoryRef === undefined ? findNode(nodes, target.nodeId) : undefined;
          return node ? layoutActions.button(node) : null;
        } }] : []),

      ]} />}
  </section>;
}
