import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, App, Breadcrumb, Button, Empty, Input, List, Modal, Select, Skeleton, Space, Tag, Tree, Typography } from 'antd';
import { ArrowLeftOutlined, DeleteOutlined, FileOutlined, FolderAddOutlined, FolderOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LayoutNode, SourceInstance } from '../../contracts/management';
import type { Api } from '../api';
import { ApiError } from '../api';
import { Failure } from '../components/feedback';
import { pendingRefreshId, RefreshProgress, usePersistentRefresh } from '../components/refresh';
import { appendNode, canMove, editNode, findNode, moveNode } from './layout-draft';

type Draft = { base: number; nodes: LayoutNode[] | null };
type TreeNode = { key: string; title: ReactNode; icon: ReactNode; children?: TreeNode[] };
export default function Library({ api }: { api: Api }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const layout = useQuery({ queryKey: ['layout'], queryFn: ({ signal }) => api.layout(signal) });
  const instances = useQuery({ queryKey: ['instances'], queryFn: ({ signal }) => api.instances(signal) });
  const [draft, setDraft] = useState<Draft | null>(null); const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<'group' | 'source' | null>(null); const [groupName, setGroupName] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  const save = useMutation({ mutationFn: (value: Draft) => api.saveLayout(value.base, value.nodes), onSuccess: async value => {
    client.setQueryData(['layout'], value); await client.invalidateQueries({ queryKey: ['library'] }); setDraft(null); message.success('目录布局已发布到 WebDAV');
  }, onError: error => { if (error instanceof ApiError && error.status === 409) void client.invalidateQueries({ queryKey: ['layout'] }); } });
  const nodes = draft ? draft.nodes : layout.data?.nodes;
  const selectedNode = nodes && selected ? findNode(nodes, selected) : undefined;
  const parentId = selectedNode?.kind === 'group' ? selectedNode.id : null;
  function change(next: LayoutNode[] | null) { setDraft({ base: draft?.base ?? layout.data!.revision, nodes: next }); }
  function add(node: LayoutNode) { change(appendNode(nodes ?? [], parentId, node)); if (parentId) setExpanded(value => [...new Set([...value, parentId])]); setAdding(null); setGroupName(''); setSelected(node.id); }
  const tree = (items: LayoutNode[]): TreeNode[] => items.map(node => ({
    key: node.id, title: <Space>{node.name}{node.kind === 'source' && !instances.data?.some(item => item.id === node.instanceId) && <Tag>实例缺失</Tag>}</Space>,
    icon: node.kind === 'group' ? <FolderOutlined /> : <FileOutlined />,
    ...(node.kind === 'group' ? { children: tree(node.children) } : {})
  }));
  return <>
    <div className="page-actions"><span>{draft ? '有未发布的修改' : `已发布修订 ${layout.data?.revision ?? '—'}`}</span><Space wrap>
      <Button disabled={!draft || save.isPending} onClick={() => { setDraft(null); setSelected(null); save.reset(); }}>放弃修改</Button>
      <Button type="primary" icon={<SaveOutlined />} disabled={!draft} loading={save.isPending} onClick={() => draft && save.mutate(draft)}>保存并发布</Button>
    </Space></div>
    <Failure error={layout.error} retry={() => void layout.refetch()} /><Failure error={save.error} />
    {draft && layout.data && draft.base !== layout.data.revision && <Alert type="warning" showIcon title="布局已被其他窗口修改。请复制需要保留的修改，重新载入后再保存。" action={<Button onClick={() => { setDraft(null); save.reset(); }}>载入最新布局</Button>} />}
    {layout.isPending ? <Skeleton active /> : layout.data && <div className="library-columns"><section className="surface layout-editor"><div className="section-heading"><Typography.Title level={3}>目录草稿</Typography.Title>{nodes === null && <Tag>默认布局</Tag>}</div>
      {nodes === null ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前按实例及内容源自动组织目录。"><Button onClick={() => change([])}>创建自定义布局</Button></Empty> : <>
        <Space wrap className="tree-toolbar"><Button disabled={save.isPending} icon={<FolderAddOutlined />} onClick={() => setAdding('group')}>新建分组</Button><Button disabled={save.isPending} icon={<PlusOutlined />} onClick={() => setAdding('source')}>添加内容源</Button></Space>
        <Typography.Paragraph type="secondary" className="tree-help">拖动可排序或移入分组。选中分组后，新内容会放入该分组。</Typography.Paragraph>
        {nodes?.length ? <Tree showIcon blockNode draggable disabled={save.isPending} treeData={tree(nodes)} selectedKeys={selected ? [selected] : []}
          expandedKeys={expanded} onExpand={keys => setExpanded(keys.map(String))}
          onSelect={keys => setSelected(keys[0] ? String(keys[0]) : null)}
          allowDrop={({ dragNode, dropNode, dropPosition }) => canMove(nodes, String(dragNode.key), String(dropNode.key), dropPosition === 0 ? 'inside' : dropPosition < 0 ? 'before' : 'after')}
          onDrop={info => { const position = info.dropPosition - Number(info.node.pos.split('-').at(-1)); change(moveNode(nodes, String(info.dragNode.key), String(info.node.key), !info.dropToGap ? 'inside' : position < 0 ? 'before' : 'after')); if (!info.dropToGap) setExpanded(value => [...new Set([...value, String(info.node.key)])]); }} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="添加分组或内容源。保存空布局会隐藏全部内容。" />}
        {selectedNode && <div className="node-editor"><label htmlFor="layout-name">显示名称</label><Input id="layout-name" value={selectedNode.name} maxLength={500} disabled={save.isPending} onChange={event => change(editNode(nodes ?? [], selectedNode.id, node => ({ ...node, name: event.target.value })))} />
          {selectedNode.kind === 'source' && <div className="secondary-id">{instances.data?.find(item => item.id === selectedNode.instanceId)?.name ?? '实例已删除'} / {selectedNode.sourceId}</div>}
          <Button type="text" danger icon={<DeleteOutlined />} disabled={save.isPending} onClick={() => { change(editNode(nodes ?? [], selectedNode.id, () => null)); setSelected(null); }}>从布局移除</Button></div>}
        <Button className="restore-default" type="link" disabled={save.isPending} onClick={() => { change(null); setSelected(null); }}>恢复按实例的默认布局</Button>
      </>}
    </section><section className="surface"><DirectoryBrowser api={api} /></section></div>}
    <Modal title={`新建分组${parentId ? ' · 放入选中分组' : ' · 放在根目录'}`} open={adding === 'group'} onCancel={() => setAdding(null)} okText="添加到草稿" cancelText="取消" okButtonProps={{ disabled: !groupName.trim() }} onOk={() => add({ id: crypto.randomUUID(), kind: 'group', name: groupName.trim(), children: [] })}>
      <label htmlFor="group-name">分组名称</label><Input id="group-name" value={groupName} onChange={event => setGroupName(event.target.value)} maxLength={500} />
    </Modal>
    {adding === 'source' && <SourcePicker api={api} instances={instances.data ?? []} close={() => setAdding(null)} add={add} />}
  </>;
}

function SourcePicker({ api, instances, close, add }: { api: Api; instances: SourceInstance[]; close: () => void; add: (node: LayoutNode) => void }) {
  const [instanceId, setInstanceId] = useState(''); const [sourceId, setSourceId] = useState('');
  const roots = useQuery({ queryKey: ['roots', instanceId, instances.find(value => value.id === instanceId)?.epoch], queryFn: ({ signal }) => api.roots(instanceId, signal), enabled: !!instanceId, retry: false });
  const pending = pendingRefreshId(roots.error);
  const refresh = usePersistentRefresh(api, { instanceId: instanceId || undefined, operationId: pending });
  const root = roots.data?.find(value => value.sourceId === sourceId);
  return <Modal title="添加内容源到草稿" open onCancel={close} okText="添加到草稿" cancelText="取消" okButtonProps={{ disabled: !root }} onOk={() => { if (root) add({ id: crypto.randomUUID(), name: root.name, kind: 'source', instanceId, sourceId }); }}>
    <div className="field-block"><label htmlFor="layout-instance">数据源实例</label><Select<string> id="layout-instance" placeholder="选择实例" value={instanceId || null} onChange={value => { setInstanceId(value); setSourceId(''); }} options={instances.map(value => ({ value: value.id, label: value.name }))} /></div>
    <div className="field-block"><label htmlFor="layout-source">内容入口</label><Select<string> id="layout-source" placeholder="选择内容源" loading={roots.isFetching || refresh.active || refresh.preparing} value={sourceId || null} disabled={!instanceId || roots.isError} onChange={value => setSourceId(value)} options={roots.data?.map(value => ({ value: value.sourceId, label: value.name })) ?? []} /></div>
    <Failure error={pending ? null : roots.error} retry={() => void roots.refetch()} /><RefreshProgress operation={refresh} reload={() => void roots.refetch()} />
  </Modal>;
}

function DirectoryBrowser({ api }: { api: Api }) {
  const [path, setPath] = useState('/');
  const directory = useQuery({ queryKey: ['library', 'directory', path], queryFn: ({ signal }) => api.browseDirectory(path, signal), retry: false });
  const pending = pendingRefreshId(directory.error);
  const refresh = usePersistentRefresh(api, { operationId: pending });
  const parent = path.slice(0, path.lastIndexOf('/')) || '/';
  return <><div className="section-heading"><Typography.Title level={3}>已发布目录</Typography.Title><Button disabled={path === '/'} type="text" icon={<ArrowLeftOutlined />} onClick={() => setPath(parent)}>上一级</Button></div>
    <Breadcrumb items={[{ title: <button className="text-button" onClick={() => setPath('/')}>根目录</button> }, ...(path === '/' ? [] : [{ title: path }])]} />
    <Failure error={pending ? null : directory.error} retry={() => void directory.refetch()} /><RefreshProgress operation={refresh} reload={() => void directory.refetch()} />
    {directory.data?.status?.error && <Alert type="warning" showIcon title="刷新失败，保留最近成功内容"
      description={`最近成功：${new Date(directory.data.status.completedAt).toLocaleString()}`} />}
    {directory.isPending ? <Skeleton active /> : directory.data?.entries.length ? <List key={path} className="directory-list" dataSource={directory.data.entries} rowKey="path"
      pagination={{ position: 'top', pageSize: 50, hideOnSinglePage: true, showSizeChanger: false, simple: true, showTotal: total => `共 ${total} 项` }}
      renderItem={entry => <List.Item><button className="directory-entry" disabled={entry.kind === 'file'} onClick={() => setPath(entry.path)}>{entry.kind === 'directory' ? <FolderOutlined /> : <FileOutlined />}<span>{entry.name}</span>{entry.kind === 'file' && <Tag>音频文件</Tag>}</button></List.Item>} /> : !directory.isError && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个目录暂时没有内容" />}
    <p className="page-footnote">这里显示当前 WebDAV 目录。草稿保存成功后才对客户端生效。</p>
  </>;
}
