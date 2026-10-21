import { useState } from 'react';
import { Alert, App, Button, Dropdown, Segmented, Skeleton, Space, Tag } from 'antd';
import { ArrowLeftOutlined, FolderAddOutlined, MoreOutlined, RedoOutlined, UndoOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import equal from 'fast-deep-equal';
import type { LayoutNode } from '../../contracts/management';
import { ApiError, type Api } from '../api';
import { Failure } from '../components/feedback';
import { appendNodes, findNode, groupIds, locateNode } from './layout-draft';
import { LayoutRootsFeedback, LayoutSources } from './layout-sources';
import { LayoutTree } from './layout-tree';

export type LayoutDraft = { base: number; nodes: LayoutNode[] | null };
type Nodes = LayoutNode[] | null;

export function LayoutEditor({ api, draft, setDraft, close, saved, showSources }: {
  api: Api; draft: LayoutDraft | null; setDraft: (value: LayoutDraft | null) => void; close: () => void; saved: () => void; showSources: () => void;
}) {
  const client = useQueryClient(); const { message } = App.useApp();
  const layout = useQuery({ queryKey: ['layout'], queryFn: ({ signal }) => api.layout(signal) });
  const instances = useQuery({ queryKey: ['instances'], queryFn: ({ signal }) => api.instances(signal) });
  const [selected, setSelected] = useState(''); const [expanded, setExpanded] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null); const [panel, setPanel] = useState<'tree' | 'sources'>('tree');
  const [history, setHistory] = useState<{ past: Nodes[]; future: Nodes[] }>({ past: [], future: [] });
  const nodes = draft ? draft.nodes : layout.data?.nodes;
  const defaults = useQuery({ queryKey: ['layout-default', instances.data?.map(instance => [instance.id, instance.epoch, instance.name])],
    queryFn: ({ signal }) => api.defaultLayout(signal), enabled: layout.isSuccess && instances.isSuccess && nodes === null, staleTime: 0 });
  const displayed = nodes === null ? defaults.data : nodes;
  const location = selected && displayed ? locateNode(displayed, selected) : undefined;
  const parentId = location ? location.node.kind === 'group' ? location.node.id : location.parentId : null;
  const save = useMutation({ mutationFn: (value: LayoutDraft) => api.saveLayout(value.base, value.nodes), onSuccess: async value => {
    client.setQueryData(['layout'], value); await client.invalidateQueries({ queryKey: ['library'] }); setDraft(null); message.success('目录已保存'); saved();
  }, onError: error => { if (error instanceof ApiError && error.status === 409) void client.invalidateQueries({ queryKey: ['layout'] }); } });
  const conflicted = !!draft && !!layout.data && draft.base !== layout.data.revision;
  const disabled = save.isPending || !displayed || conflicted || nodes === null && (defaults.isFetching || defaults.isError);
  function apply(next: Nodes) {
    if (!layout.data) return;
    setDraft(equal(next, layout.data.nodes) ? null : { base: draft?.base ?? layout.data.revision, nodes: next });
    save.reset();
  }
  function change(next: Nodes) {
    if (nodes === undefined || equal(next, nodes)) return;
    setHistory(previous => ({ past: [...previous.past.slice(-49), nodes], future: [] })); apply(next);
  }
  function travel(direction: 'undo' | 'redo') {
    if (nodes === undefined) return;
    const list = direction === 'undo' ? history.past : history.future;
    if (!list.length) return;
    const next = list[list.length - 1]!;
    setHistory(direction === 'undo' ? { past: history.past.slice(0, -1), future: [...history.future, nodes] }
      : { past: [...history.past, nodes], future: history.future.slice(0, -1) });
    apply(next); setRenaming(null); setSelected(previous => findNode(next ?? defaults.data ?? [], previous) ? previous : '');
  }
  function discard() { setDraft(null); setHistory({ past: [], future: [] }); setSelected(''); setRenaming(null); save.reset(); }
  function expand(id: string | null) { if (displayed) setExpanded([...new Set(['', ...(expanded ?? groupIds(displayed)), id ?? ''])]); }
  function createFolder(parent: string | null) {
    if (!displayed) return;
    const siblings = parent ? locateNode(displayed, parent)?.node : undefined;
    const names = (siblings?.kind === 'group' ? siblings.children : displayed).map(node => node.name);
    let name = '新建文件夹'; let suffix = 2; while (names.includes(name)) name = '新建文件夹 ' + suffix++;
    const node: LayoutNode = { id: crypto.randomUUID(), kind: 'group', name, children: [] };
    change(appendNodes(displayed, parent, [node])); expand(parent); setSelected(node.id); setRenaming(node.id); setPanel('tree');
  }
  return <div className="layout-editor">
    <div className="layout-editor-toolbar"><Button type="text" icon={<ArrowLeftOutlined aria-hidden="true" />} disabled={save.isPending} onClick={close}>返回浏览</Button>
      <Space wrap><Button icon={<UndoOutlined aria-hidden="true" />} disabled={save.isPending || conflicted || !history.past.length} onClick={() => travel('undo')}>撤销</Button>
        <Button icon={<RedoOutlined aria-hidden="true" />} disabled={save.isPending || conflicted || !history.future.length} onClick={() => travel('redo')}>重做</Button>
        <Dropdown trigger={['click']} menu={{ items: [
          { key: 'automatic', label: '恢复按来源自动排列', disabled: nodes === null || save.isPending || conflicted, onClick: () => { change(null); setSelected(''); setRenaming(null); } },
          { key: 'discard', label: '放弃本次修改', disabled: !draft || save.isPending, onClick: discard }
        ] }}><Button aria-label="目录整理选项" icon={<MoreOutlined aria-hidden="true" />} /></Dropdown>
        <Button type="primary" disabled={!draft || conflicted} loading={save.isPending} onClick={() => draft && save.mutate(draft)}>保存目录</Button>
      </Space>
    </div>
    <Failure error={layout.error} retry={() => void layout.refetch()} /><Failure error={instances.error} retry={() => void instances.refetch()} /><Failure error={conflicted ? null : save.error} />
    {conflicted && <Alert className="feedback" type="warning" showIcon title="目录已在其他窗口更新" action={<Button onClick={discard}>载入最新目录</Button>} />}
    <Segmented className="layout-mobile-tabs" value={panel} onChange={setPanel} block options={[{ label: '播放器目录', value: 'tree' }, { label: '添加内容', value: 'sources' }]} />
    <div className={'layout-workspace layout-show-' + panel}>
      {instances.isPending ? <Skeleton className="layout-tree-loading" active /> : <LayoutSources api={api} instances={instances.data ?? []} nodes={displayed ?? []} parentId={parentId} setParentId={id => setSelected(id ?? '')} disabled={disabled}
        showSources={showSources} add={items => { if (displayed) { change(appendNodes(displayed, parentId, items)); expand(parentId); setSelected(items.at(-1)!.id); setPanel('tree'); } }} />}
      <section className="layout-target" aria-label="播放器目录">
        <div className="layout-pane-heading"><div><h2>播放器目录</h2><Tag>{draft ? '未保存' : nodes === null ? '自动排列' : '自定义'}</Tag></div>
          <Button icon={<FolderAddOutlined aria-hidden="true" />} disabled={disabled} onClick={() => createFolder(parentId)}>新建文件夹</Button></div>
        {nodes === null && <LayoutRootsFeedback api={api} error={defaults.error} reload={() => void defaults.refetch()} />}
        {!displayed && !defaults.isError && !layout.isError ? <Skeleton className="layout-tree-loading" active /> : displayed && <LayoutTree nodes={displayed} instances={instances.data ?? []} selected={selected} select={setSelected}
          change={change} createFolder={createFolder} disabled={disabled} expanded={expanded} setExpanded={setExpanded} renaming={renaming} setRenaming={setRenaming} />}
      </section>
    </div>
  </div>;
}
