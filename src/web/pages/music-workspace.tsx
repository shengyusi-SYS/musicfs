import { lazy, Suspense, useEffect, useState } from 'react';
import { LRUCache } from 'lru-cache';
import { Alert, App, Button, Drawer, Dropdown, Skeleton, Space, Typography } from 'antd';
import { FolderOpenOutlined, LinkOutlined, MoreOutlined, PlusOutlined, RedoOutlined, SettingOutlined, UndoOutlined, MenuOutlined, PartitionOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SourceInstance } from '../../contracts/management';
import type { Api } from '../api';
import { Failure } from '../components/feedback';
import { SourceEditor } from '../components/source-editor';
import { MusicInspector } from '../components/music-inspector';
import { MusicTree, type MusicTreeView } from '../components/music-tree';
import { MusicPanes } from '../components/music-panes';
import { sourceDrag, type SourceDrag } from '../components/music-drag';
import { MusicBrowser } from '../components/music-browser';
import type { MusicBrowserView } from '../components/music-browser';
import { currentLayoutLocation, exportedMusic, layoutLocation, locationKey, sourceLocation, useMusicNavigation, type MusicLocation } from '../components/music-navigation';
import { useLibraryLayout } from '../components/use-library-layout';
import { useLayoutActions } from '../components/use-layout-actions';
import { AddToFolder, MoveFolder } from '../components/music-layout-controls';
import { layoutSource, type SourceDirectory } from '../components/music-listing';
import { appendNodes, locateNode, moveToFolder, type LayoutDraft } from './layout-draft';
import { SourceRootsFeedback } from '../components/source-roots-feedback';
import './music-workspace.css';

const Authentication = lazy(() => import('../components/authentication'));
type Panel = { kind: 'create' } | { kind: 'settings'; instance: SourceInstance; directoryRef?: string | undefined; label: string };
export default function MusicWorkspace({ api, showPlugins, showConnection, initialPluginId, consumePlugin, draft, setDraft }: {
  api: Api; showPlugins(continueAdding?: boolean): void; showConnection(): void; initialPluginId: string | null; consumePlugin(): void;
  draft: LayoutDraft | null; setDraft(draft: LayoutDraft | null): void;
}) {
  const client = useQueryClient(); const { modal, message } = App.useApp();
  const instances = useQuery({ queryKey: ['instances'], queryFn: ({ signal }) => api.instances(signal) });
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: ({ signal }) => api.plugins(signal) });
  const navigation = useMusicNavigation(); const { open } = navigation;
  const layout = useLibraryLayout(api, instances.data ?? [], draft, setDraft);
  const nodes = layout.nodes ?? []; const location = currentLayoutLocation(nodes, navigation.location);
  const [treeOpen, setTreeOpen] = useState(false);
  const [treePanel, setTreePanel] = useState<'sources' | 'layout'>('sources');
  const [layoutReveal, setLayoutReveal] = useState<MusicLocation | null>(null);
  const layoutActions = useLayoutActions(layout, location, open, () => showTree('layout'));
  const [adding, setAdding] = useState<{ instance: SourceInstance; roots: SourceDirectory[] } | null>(null);
  const selectedNode = location.target.kind === 'layout' ? locateNode(nodes, location.target.nodeId) : undefined;
  const parentId = selectedNode ? selectedNode.node.kind === 'group' ? selectedNode.node.id : selectedNode.parentId : null;
  const moving = layoutActions.moving ? locateNode(nodes, layoutActions.moving) : undefined;
  const [panel, setPanel] = useState<Panel | null>(() => initialPluginId ? { kind: 'create' } : null);
  const [browserViews] = useState(() => new LRUCache<string, MusicBrowserView>({ max: 40 }));
  const [treeViews] = useState(() => new Map<string, MusicTreeView>());
  useEffect(() => { if (initialPluginId) setPanel({ kind: 'create' }); }, [initialPluginId]);
  const [authenticating, setAuthenticating] = useState<{ instance: SourceInstance; needsReauthorization: boolean } | null>(null);
  const remove = useMutation({ mutationFn: (id: string) => api.deleteInstance(id), onSuccess: async () => {
    open(exportedMusic); await Promise.all(['instances', 'library', 'layout', 'roots', 'update-rules'].map(key => client.invalidateQueries({ queryKey: [key] }))); message.success('来源已删除');
  } });
  const logout = useMutation({ mutationFn: (id: string) => api.logoutInstance(id), onSuccess: async (_value, id) => {
    const instance = instances.data?.find(value => value.id === id); if (instance) open(sourceLocation(instance));
    for (const key of ['authentication', 'authentication-poll', 'roots', 'directory-status', 'refresh-current']) {
      await client.cancelQueries({ queryKey: [key, id] }); client.removeQueries({ queryKey: [key, id] });
    }
    await client.resetQueries({ queryKey: ['library'] }); await client.invalidateQueries({ queryKey: ['instances'] }); message.success('已退出账号');
  } });
  function add() { if (plugins.data && !plugins.data.some(plugin => plugin.status === 'active')) showPlugins(true); else setPanel({ kind: 'create' }); }
  function closePanel() { setPanel(null); consumePlugin(); }
  function showTree(section: 'sources' | 'layout') { setTreePanel(section); setTreeOpen(true); }
  function navigate(next: typeof location, keepTree = false) { open(next); if (!keepTree) setTreeOpen(false); closePanel(); }
  function login(instance: SourceInstance) { setAuthenticating({ instance, needsReauthorization: true }); }
  function actions(source: { instanceId: string; directoryRef?: string }, authentication: boolean, metadata: { disabled: boolean; run(): void } | null) {
    const instance = instances.data?.find(value => value.id === source.instanceId);
    const sourceRoot = location.target.kind === 'source' && location.target.directoryRef === undefined;
    const scope = { ...source, label: sourceRoot ? instance?.name ?? location.name : location.name };
    const items = [
      ...(metadata ? [{ key: 'metadata', label: '重新获取音乐资料', disabled: metadata.disabled, onClick: metadata.run }] : []),
      ...(instance ? [
        ...(authentication ? [{ key: 'login', label: '登录账号', onClick: () => login(instance) },
          { key: 'logout', label: '退出账号', disabled: logout.isPending, onClick: () => logout.mutate(instance.id) }] : []),
        ...(sourceRoot ? [{ key: 'delete', label: '删除来源', danger: true, disabled: remove.isPending, onClick: () => modal.confirm({
          title: '删除 ' + instance.name + '？', content: '删除此来源的配置与登录信息。', okText: '删除', okButtonProps: { danger: true }, cancelText: '取消', onOk: () => remove.mutateAsync(instance.id)
        }) }] : [])] : [])
    ];
    return <Space>{instance && <Button icon={<SettingOutlined />} onClick={() => setPanel({ kind: 'settings', instance, directoryRef: scope.directoryRef, label: scope.label })}>设置</Button>}
      {!!items.length && <Dropdown trigger={['click']} menu={{ items }}><Button icon={<MoreOutlined />} aria-label="当前内容的更多操作" /></Dropdown>}
    </Space>;
  }
  function copyToLayout(data: SourceDrag, parent: string | null) {
    const additions = data.roots.map(root => ({ id: crypto.randomUUID(), name: root.name, kind: 'source' as const, instanceId: data.instanceId, sourceId: root.sourceId,
      ...(root.nested ? { directoryRef: root.directoryRef } : {}) }));
    const next = appendNodes(nodes, parent, additions); layout.change(next); setLayoutReveal(layoutLocation(next, parent ?? ''));
    message.success('已加入目录草稿');
  }
  const layoutOptions = <Dropdown trigger={['click']} menu={{ items: [{ key: 'automatic', label: '恢复按来源自动排列', disabled: layout.automatic || layout.disabled, onClick: () => { layout.change(null); open(exportedMusic); } }] }}><Button size="small" type="text" aria-label="播放器目录选项" icon={<MoreOutlined />} /></Dropdown>;
  function tree(section: 'sources' | 'layout') {
    return <MusicTree key={section + ':' + instances.data?.map(instance => `${instance.id}:${instance.epoch}`).join('|')} api={api} instances={instances.data ?? []} selected={location} open={navigate}
      layout={layout} actions={layoutActions} section={section} views={treeViews} add={copyToLayout} reveal={layoutReveal} options={layoutOptions} />;
  }
  const selectedSourceId = location.target.kind === 'source' ? location.target.instanceId : layoutSource(nodes, location)?.instanceId;
  const selectedSource = instances.data?.find(instance => instance.id === selectedSourceId);
  const missingPlugin = selectedSource && plugins.isSuccess && !plugins.data.some(plugin => plugin.manifest.id === selectedSource.pluginId && plugin.status === 'active');
  return <><div className="music-workspace-toolbar"><Space wrap><Button icon={<PlusOutlined />} onClick={add}>添加来源</Button>
    <Button className="music-sources-toggle" icon={<MenuOutlined />} onClick={() => showTree('sources')}>来源</Button>
    <Button className="music-layout-toggle" icon={<PartitionOutlined />} onClick={() => showTree('layout')}>播放器目录</Button>
  </Space><Button type="primary" icon={<LinkOutlined />} loading={layout.saving} disabled={layout.conflicted} onClick={() => draft ? layout.save(showConnection) : showConnection()}>{draft ? '保存并连接' : '连接播放器'}</Button></div>
    {(draft || layout.history.future.length > 0) && <div className="music-save-bar"><span>{draft ? '目录有未保存的修改' : '已撤销修改'}</span><Space wrap>
      <Button size="small" icon={<UndoOutlined />} disabled={layout.saving || layout.conflicted || !layout.history.past.length} onClick={layout.undo}>撤销</Button>
      <Button size="small" icon={<RedoOutlined />} disabled={layout.saving || layout.conflicted || !layout.history.future.length} onClick={layout.redo}>重做</Button>
      <Button size="small" type="text" disabled={layout.saving} onClick={layout.discard}>放弃修改</Button>
      <Button size="small" type="primary" loading={layout.saving} disabled={!draft || layout.conflicted} onClick={() => layout.save()}>保存目录</Button>
    </Space></div>}
    <Failure error={instances.error} retry={() => void instances.refetch()} /><Failure error={remove.error ?? logout.error ?? layout.saveError} />
    <SourceRootsFeedback api={api} error={layout.error} reload={layout.reload} />
    {layout.conflicted && <Alert className="feedback" type="warning" showIcon title="目录已在其他窗口更新" action={<Button onClick={layout.discard}>载入最新目录</Button>} />}
    {missingPlugin && <Alert className="feedback" type="info" showIcon title="此来源需要安装插件" action={<Button size="small" onClick={() => showPlugins()}>安装插件</Button>} />}
    {instances.isPending ? <Skeleton active /> : instances.isError ? null : !instances.data?.length ? <section className="surface welcome-surface"><div className="welcome-symbol"><FolderOpenOutlined /></div><Typography.Title level={2}>把喜欢的音乐放在一起</Typography.Title>
      <Typography.Paragraph type="secondary">连接音乐账号，交给你常用的播放器。</Typography.Paragraph><Button type="primary" onClick={add}>添加音乐来源</Button></section>
      : <MusicPanes sources={tree('sources')} layout={tree('layout')} content={layout.loading && location.target.kind === 'layout' ? <Skeleton className="music-content" active /> : <MusicBrowser key={locationKey(location)} api={api} instances={instances.data} location={location} open={navigate} actions={actions} login={login}
          nodes={nodes} views={browserViews} layoutActions={layoutActions} editingDisabled={layout.disabled} add={(instance, roots) => setAdding({ instance, roots })} />} />}
    <Drawer className="music-mobile-tree" title={treePanel === 'layout' ? '播放器目录' : '音乐来源'} open={treeOpen} onClose={() => setTreeOpen(false)} placement={treePanel === 'layout' ? 'right' : 'left'} size={320} destroyOnHidden>{tree(treePanel)}</Drawer>
    {adding && <AddToFolder nodes={nodes} initial={parentId} count={adding.roots.length} close={() => setAdding(null)} add={parent => {
      copyToLayout(sourceDrag(adding.instance.id, adding.roots), parent); setAdding(null);
    }} />}
    {moving && <MoveFolder name={moving.node.name} current={moving.parentId} nodes={nodes} exclude={moving.node.id} close={() => layoutActions.setMoving(null)} move={parent => {
      const next = moveToFolder(nodes, moving.node.id, parent); layout.change(next); layoutActions.setMoving(null); setLayoutReveal(layoutLocation(next, parent ?? ''));
    }} />}
    {panel?.kind === 'create' && <SourceEditor api={api} initialPluginId={initialPluginId} close={closePanel}
      showPlugins={() => { closePanel(); showPlugins(true); }} saved={(instance, authenticate) => { closePanel(); open(sourceLocation(instance)); if (authenticate) setAuthenticating({ instance, needsReauthorization: false }); }} />}
    {panel?.kind === 'settings' && <MusicInspector key={panel.instance.id + ':' + panel.directoryRef} api={api} instance={panel.instance} directoryRef={panel.directoryRef} label={panel.label} close={closePanel}
      showPlugins={() => { closePanel(); showPlugins(); }} />}
    {authenticating && <Suspense fallback={<Skeleton active />}><Authentication api={api} instance={authenticating.instance} needsReauthorization={authenticating.needsReauthorization} close={() => setAuthenticating(null)}
      done={() => { open(sourceLocation(authenticating.instance)); setAuthenticating(null); }} /></Suspense>}
  </>;
}
