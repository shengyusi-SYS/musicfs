import { useState, type ReactNode } from 'react';
import { Alert, App, Button, Drawer, Empty, Input, Modal, Select, Skeleton, Space, Tag, Tree } from 'antd';
import { DeleteOutlined, FileOutlined, FolderAddOutlined, FolderOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LayoutNode, SourceInstance } from '../../contracts/management';
import { ApiError, type Api } from '../api';
import { Failure } from '../components/feedback';
import { pendingRefreshId, RefreshProgress, usePersistentRefresh } from '../components/refresh';
import { appendNode, canMove, editNode, findNode, moveNode } from './layout-draft';

export type LayoutDraft = { base: number; nodes: LayoutNode[] | null };
type TreeNode = { key: string; title: ReactNode; icon: ReactNode; children?: TreeNode[] };

export function LayoutEditor({ api, draft, setDraft, close }: { api: Api; draft: LayoutDraft | null; setDraft: (value: LayoutDraft | null) => void; close: () => void }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const layout = useQuery({ queryKey: ['layout'], queryFn: ({ signal }) => api.layout(signal) });
  const instances = useQuery({ queryKey: ['instances'], queryFn: ({ signal }) => api.instances(signal) });
  const [selected, setSelected] = useState<string | null>(null); const [adding, setAdding] = useState<'group' | 'source' | null>(null);
  const [groupName, setGroupName] = useState(''); const [expanded, setExpanded] = useState<string[]>([]);
  const save = useMutation({ mutationFn: (value: LayoutDraft) => api.saveLayout(value.base, value.nodes), onSuccess: async value => {
    client.setQueryData(['layout'], value); await client.invalidateQueries({ queryKey: ['library'] }); setDraft(null); message.success('目录已保存'); close();
  }, onError: error => { if (error instanceof ApiError && error.status === 409) void client.invalidateQueries({ queryKey: ['layout'] }); } });
  const nodes = draft ? draft.nodes : layout.data?.nodes;
  const selectedNode = nodes && selected ? findNode(nodes, selected) : undefined;
  const parentId = selectedNode?.kind === 'group' ? selectedNode.id : null;
  function change(next: LayoutNode[] | null) { setDraft({ base: draft?.base ?? layout.data!.revision, nodes: next }); }
  function add(node: LayoutNode) { change(appendNode(nodes ?? [], parentId, node)); if (parentId) setExpanded(value => [...new Set([...value, parentId])]); setAdding(null); setGroupName(''); setSelected(node.id); }
  const tree = (items: LayoutNode[]): TreeNode[] => items.map(node => ({ key: node.id,
    title: <Space>{node.name}{node.kind === 'source' && instances.isSuccess && !instances.data.some(item => item.id === node.instanceId) && <Tag>来源已删除</Tag>}</Space>,
    icon: node.kind === 'group' ? <FolderOutlined aria-hidden="true" /> : <FileOutlined aria-hidden="true" />, ...(node.kind === 'group' ? { children: tree(node.children) } : {}) }));
  return <Drawer title="整理目录" open onClose={() => { if (!save.isPending) close(); }} closable={!save.isPending} mask={{ closable: !save.isPending }} size="large" footer={<div className="dialog-actions"><Button disabled={!draft || save.isPending} onClick={() => { setDraft(null); setSelected(null); save.reset(); }}>放弃修改</Button>
    <Button type="primary" disabled={!draft} loading={save.isPending} onClick={() => draft && save.mutate(draft)}>保存目录</Button></div>}>
    <Failure error={layout.error} retry={() => void layout.refetch()} /><Failure error={instances.error} /><Failure error={save.error} />
    {draft && layout.data && draft.base !== layout.data.revision && <Alert className="feedback" type="warning" showIcon title="目录已在其他窗口更新" action={<Button onClick={() => { setDraft(null); save.reset(); }}>载入最新目录</Button>} />}
    {layout.isPending ? <Skeleton active /> : layout.data && <>
      {nodes === null ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="按音乐来源自动排列"><Button onClick={() => change([])}>自定义目录</Button></Empty> : <>
        <div className="page-actions"><Space wrap><Button disabled={save.isPending} icon={<FolderAddOutlined aria-hidden="true" />} onClick={() => setAdding('group')}>新建文件夹</Button><Button disabled={save.isPending} icon={<PlusOutlined aria-hidden="true" />} onClick={() => setAdding('source')}>添加内容</Button></Space></div>
        {nodes?.length ? <><div className="muted-note">拖动排序，或选中目录修改名称。</div><Tree showIcon blockNode draggable disabled={save.isPending} treeData={tree(nodes)} selectedKeys={selected ? [selected] : []} expandedKeys={expanded} onExpand={keys => setExpanded(keys.map(String))} onSelect={keys => setSelected(keys[0] ? String(keys[0]) : null)}
          allowDrop={({ dragNode, dropNode, dropPosition }) => canMove(nodes, String(dragNode.key), String(dropNode.key), dropPosition === 0 ? 'inside' : dropPosition < 0 ? 'before' : 'after')}
          onDrop={info => { const position = info.dropPosition - Number(info.node.pos.split('-').at(-1)); change(moveNode(nodes, String(info.dragNode.key), String(info.node.key), !info.dropToGap ? 'inside' : position < 0 ? 'before' : 'after')); if (!info.dropToGap) setExpanded(value => [...new Set([...value, String(info.node.key)])]); }} /></> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="添加想在播放器中看到的内容" />}
        {selectedNode && <div className="node-editor"><label htmlFor="layout-name">显示名称</label><Input id="layout-name" value={selectedNode.name} maxLength={500} disabled={save.isPending} onChange={event => change(editNode(nodes ?? [], selectedNode.id, node => ({ ...node, name: event.target.value })))} />
          <Button type="text" danger icon={<DeleteOutlined aria-hidden="true" />} disabled={save.isPending} onClick={() => { change(editNode(nodes ?? [], selectedNode.id, () => null)); setSelected(null); }}>从目录移除</Button></div>}
        <Button className="restore-default" type="link" disabled={save.isPending} onClick={() => { change(null); setSelected(null); }}>使用自动布局</Button>
      </>}
    </>}
    <Modal title={parentId ? '在选中文件夹中新建' : '新建文件夹'} open={adding === 'group'} onCancel={() => setAdding(null)} okText="添加" cancelText="取消" okButtonProps={{ disabled: !groupName.trim() }} onOk={() => add({ id: crypto.randomUUID(), kind: 'group', name: groupName.trim(), children: [] })}>
      <div className="field-block"><label htmlFor="group-name">文件夹名称</label><Input id="group-name" value={groupName} onChange={event => setGroupName(event.target.value)} maxLength={500} autoFocus /></div>
    </Modal>
    {adding === 'source' && <SourcePicker api={api} instances={instances.data ?? []} close={() => setAdding(null)} add={add} />}
  </Drawer>;
}

function SourcePicker({ api, instances, close, add }: { api: Api; instances: SourceInstance[]; close: () => void; add: (node: LayoutNode) => void }) {
  const [instanceId, setInstanceId] = useState(instances.length === 1 ? instances[0]!.id : ''); const [sourceId, setSourceId] = useState('');
  const roots = useQuery({ queryKey: ['roots', instanceId, instances.find(value => value.id === instanceId)?.epoch], queryFn: ({ signal }) => api.roots(instanceId, signal), enabled: !!instanceId });
  const pending = pendingRefreshId(roots.error); const refresh = usePersistentRefresh(api, { instanceId: instanceId || undefined, operationId: pending });
  const selected = sourceId || (roots.data?.length === 1 ? roots.data[0]!.sourceId : ''); const root = roots.data?.find(value => value.sourceId === selected);
  return <Modal title="添加音乐内容" open onCancel={close} okText="添加" cancelText="取消" okButtonProps={{ disabled: !root }} onOk={() => { if (root) add({ id: crypto.randomUUID(), name: root.name, kind: 'source', instanceId, sourceId: root.sourceId }); }}>
    <div className="field-block"><label htmlFor="layout-instance">音乐来源</label><Select<string> id="layout-instance" placeholder="选择来源" value={instanceId || null} onChange={value => { setInstanceId(value); setSourceId(''); }} options={instances.map(value => ({ value: value.id, label: value.name }))} /></div>
    <div className="field-block"><label htmlFor="layout-source">音乐内容</label><Select<string> id="layout-source" placeholder="选择歌单或内容" loading={roots.isFetching || refresh.active || refresh.preparing} value={selected || null} disabled={!instanceId || roots.isError} onChange={setSourceId} options={roots.data?.map(value => ({ value: value.sourceId, label: value.name })) ?? []} /></div>
    <Failure error={pending ? null : roots.error} retry={() => void roots.refetch()} /><RefreshProgress operation={refresh} reload={() => void roots.refetch()} />
  </Modal>;
}
