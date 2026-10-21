import { useState } from 'react';
import { Button, Checkbox, Empty, Input, Select, Skeleton, Tag, TreeSelect } from 'antd';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { LayoutNode, SourceInstance } from '../../contracts/management';
import type { Api } from '../api';
import { Failure } from '../components/feedback';
import { pendingRefreshId, RefreshProgress, usePersistentRefresh } from '../components/refresh';
import { folderOptions } from './layout-draft';

export function LayoutSources({ api, instances, nodes, parentId, setParentId, add, disabled, showSources }: {
  api: Api; instances: SourceInstance[]; nodes: LayoutNode[]; parentId: string | null;
  setParentId: (id: string | null) => void; add: (nodes: LayoutNode[]) => void; disabled: boolean; showSources: () => void;
}) {
  const [chosenInstance, setChosenInstance] = useState('');
  const instance = instances.find(item => item.id === chosenInstance) ?? instances[0];
  return <section className="layout-sources" aria-label="可添加的音乐内容">
    <div className="layout-pane-heading"><h2>音乐内容</h2><span>可多选</span></div>
    {instances.length > 1 && <Select<string> className="layout-instance" aria-label="选择音乐来源" value={instance?.id ?? null} onChange={setChosenInstance}
      options={instances.map(item => ({ value: item.id, label: item.name }))} />}
    {instance ? <SourceContents key={instance.id + ':' + instance.epoch} api={api} instance={instance} nodes={nodes} parentId={parentId} setParentId={setParentId} add={add} disabled={disabled} />
      : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有音乐来源"><Button onClick={showSources}>添加来源</Button></Empty>}
  </section>;
}

function SourceContents({ api, instance, nodes, parentId, setParentId, add, disabled }: {
  api: Api; instance: SourceInstance; nodes: LayoutNode[]; parentId: string | null; setParentId: (id: string | null) => void;
  add: (nodes: LayoutNode[]) => void; disabled: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]); const [filter, setFilter] = useState('');
  const roots = useQuery({ queryKey: ['roots', instance.id, instance.epoch], queryFn: ({ signal }) => api.roots(instance.id, signal) });
  const needle = filter.trim().toLocaleLowerCase();
  const visible = roots.data?.filter(root => root.name.toLocaleLowerCase().includes(needle)) ?? [];
  const chosen = roots.data?.filter(root => selected.includes(root.sourceId)) ?? [];
  const all = visible.length > 0 && visible.every(root => selected.includes(root.sourceId));
  const used = new Set<string>();
  const visit = (items: LayoutNode[]) => { for (const node of items) { if (node.kind === 'group') visit(node.children); else if (node.instanceId === instance.id) used.add(node.sourceId); } }; visit(nodes);
  return <>
    <Input className="layout-source-search" aria-label="搜索音乐内容" placeholder="搜索歌单或内容" prefix={<SearchOutlined aria-hidden="true" />} allowClear value={filter} onChange={event => setFilter(event.target.value)} />
    <div className="layout-source-list">
      {roots.isPending ? <Skeleton active /> : <>
        <LayoutRootsFeedback api={api} error={roots.error} reload={() => void roots.refetch()} />
        {!!visible.length && <Checkbox className="layout-source-all" checked={all} indeterminate={!all && visible.some(root => selected.includes(root.sourceId))}
          onChange={event => setSelected(previous => event.target.checked ? [...new Set([...previous, ...visible.map(root => root.sourceId)])] : previous.filter(id => !visible.some(root => root.sourceId === id)))}>{needle ? '全选搜索结果' : '全选'}</Checkbox>}
        {visible.map(root => <Checkbox className="layout-source-option" key={root.sourceId} checked={selected.includes(root.sourceId)} onChange={event => setSelected(previous => event.target.checked ? [...previous, root.sourceId] : previous.filter(id => id !== root.sourceId))}>
          <span>{root.name}</span>{used.has(root.sourceId) && <Tag>已添加</Tag>}
        </Checkbox>)}
        {!visible.length && !roots.isError && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={needle ? '没有匹配的内容' : '这个来源还没有内容'} />}
      </>}
    </div>
    <div className="layout-add-bar"><label htmlFor="layout-destination">添加到</label>
      <TreeSelect id="layout-destination" className="layout-destination" value={parentId ?? ''} onChange={value => setParentId(value || null)} disabled={disabled}
        treeDefaultExpandAll showSearch treeNodeFilterProp="title" treeData={[{ value: '', title: '全部音乐', children: folderOptions(nodes) }]} />
      <Button type="primary" block icon={<PlusOutlined aria-hidden="true" />} disabled={disabled || !chosen.length} onClick={() => {
        add(chosen.map(root => ({ id: crypto.randomUUID(), name: root.name, kind: 'source', instanceId: instance.id, sourceId: root.sourceId })));
        setSelected([]);
      }}>添加{chosen.length ? ' ' + chosen.length + ' 项' : '选中内容'}</Button>
    </div>
  </>;
}

export function LayoutRootsFeedback({ api, error, reload }: { api: Api; error: Error | null; reload: () => void }) {
  const pending = pendingRefreshId(error);
  return pending ? <PendingRoots key={pending} api={api} operationId={pending} reload={reload} /> : <Failure error={error} retry={reload} />;
}
function PendingRoots({ api, operationId, reload }: { api: Api; operationId: string; reload: () => void }) {
  const refresh = usePersistentRefresh(api, { operationId, onCompleted: reload });
  return <RefreshProgress operation={refresh} reload={reload} />;
}
