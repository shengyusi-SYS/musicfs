import { useMemo, useState } from 'react';
import { Alert, Breadcrumb, Button, Dropdown, Empty, Input, List, Skeleton, Space, Typography } from 'antd';
import { ArrowRightOutlined, FileOutlined, FolderOutlined, MoreOutlined, ReloadOutlined, SearchOutlined, SettingOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { Api } from '../api';
import { Failure } from '../components/feedback';
import { pendingRefreshId, RefreshProgress, usePersistentRefresh } from '../components/refresh';
import { RefreshPolicyControl } from '../components/refresh-policy';
import { LayoutEditor, type LayoutDraft } from './layout-editor';

export default function Library({ api, path, setPath, draft, setDraft, showSources, showConnection }: {
  api: Api; path: string; setPath: (value: string) => void; draft: LayoutDraft | null; setDraft: (value: LayoutDraft | null) => void; showSources: () => void; showConnection: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) return <LayoutEditor api={api} draft={draft} setDraft={setDraft} close={() => setEditing(false)} saved={() => { setPath('/'); setEditing(false); }} showSources={showSources} />;
  return <><div className="page-actions"><Typography.Text type="secondary">{draft ? '有未保存的目录修改' : '播放器看到的音乐文件夹'}</Typography.Text><Space wrap>
    <Button icon={<SettingOutlined aria-hidden="true" />} onClick={() => setEditing(true)}>整理目录{draft && <span className="unsaved-dot" />}</Button>
    <Button type="primary" icon={<ArrowRightOutlined aria-hidden="true" />} onClick={showConnection}>连接播放器</Button>
  </Space></div><section className="surface directory-surface"><DirectoryBrowser api={api} path={path} setPath={setPath} showSources={showSources} /></section>
  </>;
}

function DirectoryBrowser({ api, path, setPath, showSources }: { api: Api; path: string; setPath: (value: string) => void; showSources: () => void }) {
  const [filter, setFilter] = useState('');
  const directory = useQuery({ queryKey: ['library', 'directory', path], queryFn: ({ signal }) => api.browseDirectory(path, signal) });
  const pending = pendingRefreshId(directory.error); const source = directory.data?.source;
  const configuration = useQuery({ queryKey: ['configuration', source?.pluginId], enabled: !!source?.pluginId,
    queryFn: ({ signal }) => api.configuration(source!.pluginId, signal) });
  const refresh = usePersistentRefresh(api, { instanceId: source?.instanceId, operationId: pending });
  const busy = refresh.active || refresh.starting || refresh.preparing;
  const segments = path.split('/').filter(Boolean);
  const entries = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return needle ? directory.data?.entries.filter(entry => entry.name.toLocaleLowerCase().includes(needle)) : directory.data?.entries;
  }, [directory.data?.entries, filter]);
  function open(next: string) { setFilter(''); setPath(next); }
  return <><div className="directory-toolbar"><Breadcrumb items={[{ title: <button className="text-button" onClick={() => open('/')}>全部音乐</button> }, ...segments.map((segment, index) => ({ title: <button className="text-button" onClick={() => open('/' + segments.slice(0, index + 1).join('/'))}>{segment}</button> }))]} />
    {source && <Space wrap><RefreshPolicyControl key={source.instanceId + ':' + source.directoryRef} api={api} instanceId={source.instanceId} directoryRef={source.directoryRef} disabled={busy} />
      <Button icon={<ReloadOutlined aria-hidden="true" />} disabled={busy} onClick={() => refresh.start({ kind: 'directory', directoryRef: source.directoryRef })}>更新</Button>
      {configuration.data?.metadataRefresh && directory.data?.entries.some(entry => entry.kind === 'file') && <Dropdown menu={{ items: [{ key: 'metadata', label: '重新获取音乐资料', onClick: () => refresh.start({ kind: 'metadata', directoryRef: source.directoryRef }) }] }}>
        <Button icon={<MoreOutlined aria-hidden="true" />} aria-label="更多更新选项" disabled={busy} />
      </Dropdown>}
    </Space>}
  </div>
    {((directory.data?.entries.length ?? 0) > 10 || !!filter) && <Input className="directory-search" prefix={<SearchOutlined aria-hidden="true" />} allowClear placeholder="搜索当前目录" aria-label="搜索当前目录" value={filter} onChange={event => setFilter(event.target.value)} />}
    <Failure error={pending ? null : directory.error} retry={() => void directory.refetch()} /><RefreshProgress operation={refresh} reload={() => refresh.view?.scope.kind === 'file-info' || refresh.view?.scope.kind === 'metadata' ? refresh.start(refresh.view.scope) : void directory.refetch()} />
    {directory.data?.status?.error && <Alert className="feedback" type="warning" showIcon title="更新失败，仍显示上次内容" />}
    {(directory.data?.status?.pendingFileInfo ?? 0) > 0 && <Alert className="feedback" type="info" showIcon title="首次挂载前，需要准备文件信息"
      action={source && <Button size="small" disabled={busy} onClick={() => refresh.start({ kind: 'file-info', directoryRef: source.directoryRef })}>准备文件</Button>} />}
    {directory.isPending ? <Skeleton active /> : entries?.length ? <List key={path + ':' + filter} className="directory-list" dataSource={entries} rowKey="path"
      pagination={{ position: 'bottom', pageSize: 50, hideOnSinglePage: true, showSizeChanger: false, simple: true, showTotal: total => '共 ' + total.toLocaleString() + ' 项' }}
      renderItem={entry => <List.Item>{entry.kind === 'directory'
        ? <button className="directory-entry" onClick={() => open(entry.path)}><FolderOutlined aria-hidden="true" /><span>{entry.name}</span><ArrowRightOutlined aria-hidden="true" className="entry-arrow" /></button>
        : <div className="directory-entry directory-file"><FileOutlined aria-hidden="true" /><span>{entry.name}</span><Typography.Text type="secondary">{entry.name.split('.').pop()?.toUpperCase()}</Typography.Text></div>}
      </List.Item>} /> : !directory.isError && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filter ? '没有找到匹配的名称' : '这里还没有音乐'}>
        {filter ? <Button onClick={() => setFilter('')}>清除搜索</Button> : <Button onClick={showSources}>添加音乐来源</Button>}</Empty>}
  </>;
}
