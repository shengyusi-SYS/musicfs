import { useMemo, useState } from 'react';
import { Alert, Breadcrumb, Button, Empty, Input, Skeleton, Space, Table, Typography } from 'antd';
import { FileOutlined, FolderOutlined, MenuOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { SourceInstance } from '../../contracts/management';
import type { Api } from '../api';
import { Failure } from './feedback';
import { pendingRefreshId, RefreshProgress, usePersistentRefresh } from './refresh';
import { listingQuery, locationKey, type MusicEntry, type MusicLocation, type MusicListing } from './music-navigation';

export function MusicBrowser({ api, instances, location, open, showTree, actions, login, organize }: {
  api: Api; instances: SourceInstance[]; location: MusicLocation; open(location: MusicLocation): void; showTree(): void;
  actions(source: NonNullable<MusicListing['source']>, authentication: boolean, metadata: { disabled: boolean; run(): void } | null): React.ReactNode;
  login(instance: SourceInstance): void; organize(): void;
}) {
  const [filter, setFilter] = useState('');
  const listing = useQuery(listingQuery(api, location, instances));
  const sourceInstanceId = location.target.kind === 'source' ? location.target.instanceId : undefined;
  const source = listing.data?.source ?? (location.target.kind === 'source' ? { instanceId: location.target.instanceId,
    pluginId: instances.find(instance => instance.id === sourceInstanceId)?.pluginId ?? '',
    ...(location.target.directoryRef === undefined ? {} : { directoryRef: location.target.directoryRef }) } : undefined);
  const instance = instances.find(value => value.id === source?.instanceId);
  const configuration = useQuery({ queryKey: ['configuration', source?.pluginId], enabled: !!source?.pluginId, queryFn: ({ signal }) => api.configuration(source!.pluginId, signal) });
  const pending = pendingRefreshId(listing.error);
  const refresh = usePersistentRefresh(api, { instanceId: source?.instanceId, operationId: pending });
  const busy = refresh.active || refresh.starting || refresh.preparing;
  const reauthorize = instance && configuration.data?.authentication ? () => login(instance) : undefined;
  const entries = useMemo(() => listing.data?.entries.filter(entry => entry.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())) ?? [], [listing.data, filter]);
  const crumbs = [...location.ancestors, location];
  function crumbName(crumb: typeof crumbs[number]) {
    const target = crumb.target;
    return target.kind === 'source' && target.directoryRef === undefined ? instances.find(value => value.id === target.instanceId)?.name ?? crumb.name : crumb.name;
  }
  return <section className="music-content" aria-label="音乐内容">
    <div className={'music-breadcrumb' + (!location.ancestors.length ? ' music-breadcrumb-root' : '')}><Button className="music-tree-toggle" type="text" icon={<MenuOutlined />} aria-label="打开目录树" onClick={showTree} />
      {!!location.ancestors.length && <Breadcrumb items={crumbs.map((crumb, index) => ({ title: index === crumbs.length - 1 ? crumbName(crumb) : <button className="text-button" onClick={() => open({ ...crumb, ancestors: crumbs.slice(0, index) })}>{crumbName(crumb)}</button> }))} />}
    </div>
    <header className="music-content-heading"><div><Typography.Title level={2}>{location.target.kind === 'source' && location.target.directoryRef === undefined ? instance?.name ?? location.name : location.name}</Typography.Title>
      <div className="music-content-meta">{listing.data ? `${listing.data.entries.length.toLocaleString()} 项` : '正在载入'}
        {listing.data?.status?.completedAt && ` · 更新于 ${new Date(listing.data.status.completedAt).toLocaleString()}`}</div></div>
      {source && <Space wrap>{(listing.data?.status?.pendingFileInfo ?? 0) > 0 && <Button disabled={busy} onClick={() => refresh.start({ kind: 'file-info', directoryRef: source.directoryRef! })}>准备文件</Button>}
        <Button icon={<ReloadOutlined />} loading={busy} onClick={() => refresh.start(source.directoryRef === undefined ? { kind: 'instance' } : { kind: 'directory', directoryRef: source.directoryRef })}>更新</Button>
        {actions(source, !!configuration.data?.authentication, configuration.data?.metadataRefresh && source.directoryRef !== undefined && listing.data?.entries.some(entry => entry.kind === 'file')
          ? { disabled: busy, run: () => refresh.start({ kind: 'metadata', directoryRef: source.directoryRef! }) } : null)}
      </Space>}
    </header>
    <div className="music-content-feedback"><Failure error={pending ? null : listing.error} retry={() => void listing.refetch()} reauthorize={reauthorize} />
      <RefreshProgress operation={refresh} labels={configuration.data?.statistics} reload={() => refresh.view && refresh.start(refresh.view.scope)} reauthorize={reauthorize} />
      {listing.data?.status?.error && !refresh.active && <Alert className="feedback" type="warning" showIcon title="上次更新未完成" action={<Button size="small" onClick={() => refresh.start({ kind: 'directory', directoryRef: source!.directoryRef! })}>重试</Button>} />}
    </div>
    <div className="music-list-toolbar"><Input prefix={<SearchOutlined />} placeholder="搜索当前目录" aria-label="搜索当前目录" allowClear value={filter} onChange={event => setFilter(event.target.value)} />
      {filter && <Typography.Text type="secondary">{entries.length} 项</Typography.Text>}
    </div>
    {listing.isPending ? <Skeleton className="music-list-loading" active paragraph={{ rows: 6 }} /> : listing.data && <Table<MusicEntry> className="music-file-table" size="middle" dataSource={entries}
      rowKey={entry => entry.location ? locationKey(entry.location) : entry.name} {...(entries.length > 12 ? { scroll: { y: 'calc(100dvh - 480px)' } } : {})} pagination={{ pageSize: 50, hideOnSinglePage: true, showSizeChanger: false, simple: true }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filter ? '没有匹配的名称' : '此目录为空'}>
        {!filter && location.target.kind === 'export' && <Button onClick={organize}>整理目录</Button>}
      </Empty> }} columns={[
        { title: '名称', key: 'name', render: (_value, entry) => entry.location
          ? <button className="music-folder-link" onClick={() => open(entry.location!)}><FolderOutlined /><span>{entry.name}</span></button>
          : <span className="music-file-name"><FileOutlined /><span>{entry.name}</span></span> },
        { title: '类型', key: 'kind', width: 100, responsive: ['sm'], render: (_value, entry) => <span className="secondary-id">{entry.kind === 'directory' ? '文件夹' : entry.name.split('.').at(-1)?.toUpperCase()}</span> }
      ]} />}
  </section>;
}
