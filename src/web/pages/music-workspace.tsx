import { t } from '../i18n';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LRUCache } from 'lru-cache';
import { Alert, App, Button, Drawer, Dropdown, Grid, Skeleton, Space, Tooltip, Typography } from 'antd';
import { CloseOutlined, FolderOpenOutlined, LinkOutlined, MoreOutlined, PlusOutlined, RedoOutlined, SettingOutlined, UndoOutlined, MenuOutlined, PartitionOutlined } from '@ant-design/icons';
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
export default function MusicWorkspace({ api, sidebar, serviceControl, showPlugins, showConnection, initialPluginId, consumePlugin, draft, setDraft }: {
  sidebar: HTMLElement | null; serviceControl: ReactNode;
  api: Api; showPlugins(continueAdding?: boolean): void; showConnection(): void; initialPluginId: string | null; consumePlugin(): void;
  draft: LayoutDraft | null; setDraft(draft: LayoutDraft | null): void;
}) {
  const client = useQueryClient(); const { modal, message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const [organizerOpen, setOrganizerOpen] = useState(() => localStorage.getItem('musicfs.library.player-pane.open') === 'true');
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
  const moving = layoutActions.moving ? locateNode(nodes, layoutActions.moving) : undefined;
  const [panel, setPanel] = useState<Panel | null>(() => initialPluginId ? { kind: 'create' } : null);
  const [browserViews] = useState(() => new LRUCache<string, MusicBrowserView>({ max: 40 }));
  const [treeViews] = useState(() => new Map<string, MusicTreeView>());
  const destination = location.target.kind === 'layout' ? location : treeViews.get('layout')?.location ?? layoutReveal;
  const selectedNode = destination?.target.kind === 'layout' ? locateNode(nodes, destination.target.nodeId) : undefined;
  const parentId = selectedNode ? selectedNode.node.kind === 'group' ? selectedNode.node.id : selectedNode.parentId : null;
  useEffect(() => { if (initialPluginId) setPanel({ kind: 'create' }); }, [initialPluginId]);
  useEffect(() => {
    if (treeOpen && (treePanel === 'sources' && screens.md || treePanel === 'layout' && screens.lg)) {
      if (treePanel === 'layout') setOrganizer(true);
      setTreeOpen(false);
    }
  }, [screens.md, screens.lg, treeOpen, treePanel]);
  const [authenticating, setAuthenticating] = useState<{ instance: SourceInstance; needsReauthorization: boolean } | null>(null);
  const remove = useMutation({ mutationFn: (id: string) => api.deleteInstance(id), onSuccess: async () => {
    open(exportedMusic); await Promise.all(['instances', 'library', 'layout', 'roots', 'update-rules'].map(key => client.invalidateQueries({ queryKey: [key] }))); message.success(t("来源已删除"));
  } });
  const logout = useMutation({ mutationFn: (id: string) => api.logoutInstance(id), onSuccess: async (_value, id) => {
    const instance = instances.data?.find(value => value.id === id); if (instance) open(sourceLocation(instance));
    for (const key of ['authentication', 'authentication-poll', 'roots', 'directory-status', 'refresh-current']) {
      await client.cancelQueries({ queryKey: [key, id] }); client.removeQueries({ queryKey: [key, id] });
    }
    await client.resetQueries({ queryKey: ['library'] }); await client.invalidateQueries({ queryKey: ['instances'] }); message.success(t("已退出账号"));
  } });
  function add() { setTreeOpen(false); if (plugins.data && !plugins.data.some(plugin => plugin.status === 'active')) showPlugins(true); else setPanel({ kind: 'create' }); }
  function closePanel() { setPanel(null); consumePlugin(); }
  function setOrganizer(value: boolean) { setOrganizerOpen(value); localStorage.setItem('musicfs.library.player-pane.open', String(value)); }
  function showTree(section: 'sources' | 'layout') {
    if (section === 'layout' && screens.lg) { setOrganizer(true); return; }
    setTreePanel(section); setTreeOpen(true);
  }
  function toggleOrganizer() { if (screens.lg) setOrganizer(!organizerOpen); else if (treeOpen && treePanel === 'layout') setTreeOpen(false); else showTree('layout'); }
  function navigate(next: typeof location) { open(next); setTreeOpen(false); closePanel(); }
  function login(instance: SourceInstance) { setAuthenticating({ instance, needsReauthorization: true }); }
  function actions(source: { instanceId: string; directoryRef?: string }, authentication: boolean, metadata: { disabled: boolean; run(): void } | null) {
    const instance = instances.data?.find(value => value.id === source.instanceId);
    const sourceRoot = location.target.kind === 'source' && location.target.directoryRef === undefined;
    const scope = { ...source, label: sourceRoot ? instance?.name ?? location.name : location.name };
    const items = [
      ...(metadata ? [{ key: 'metadata', label: t("重新获取音乐资料"), disabled: metadata.disabled, onClick: metadata.run }] : []),
      ...(instance ? [
        ...(authentication ? [{ key: 'login', label: t("登录账号"), onClick: () => login(instance) },
          { key: 'logout', label: t("退出账号"), disabled: logout.isPending, onClick: () => logout.mutate(instance.id) }] : []),
        ...(sourceRoot ? [{ key: 'delete', label: t("删除来源"), danger: true, disabled: remove.isPending, onClick: () => modal.confirm({
          title: t('删除「{{name}}」？', { name: instance.name }), content: t("删除此来源的配置与登录信息。"), okText: t("删除"), okButtonProps: { danger: true }, cancelText: t("取消"), onOk: () => remove.mutateAsync(instance.id)
        }) }] : [])] : [])
    ];
    return <Space>{instance && <Button icon={<SettingOutlined />} onClick={() => setPanel({ kind: 'settings', instance, directoryRef: scope.directoryRef, label: scope.label })}>{t("设置")}</Button>}
      {!!items.length && <Dropdown trigger={['click']} menu={{ items }}><Button icon={<MoreOutlined />} aria-label={t("当前内容的更多操作")} /></Dropdown>}
    </Space>;
  }
  function copyToLayout(data: SourceDrag, parent: string | null, folderName?: string) {
    const additions = data.roots.map(root => ({ id: crypto.randomUUID(), name: root.name, kind: 'source' as const, instanceId: data.instanceId, sourceId: root.sourceId,
      ...(root.nested ? { directoryRef: root.directoryRef } : {}) }));
    const folder = folderName ? { id: crypto.randomUUID(), name: folderName, kind: 'group' as const, children: additions } : undefined;
    const next = appendNodes(nodes, parent, folder ? [folder] : additions); layout.change(next); setLayoutReveal(layoutLocation(next, folder?.id ?? parent ?? ''));
    showTree('layout');
  }
  const layoutOptions = <><Dropdown trigger={['click']} menu={{ items: [
    { key: 'automatic', label: t("恢复按来源自动排列"), disabled: layout.automatic || layout.disabled, onClick: () => { layout.change(null); open(exportedMusic); } },
    ...(draft || layout.history.future.length ? [{ key: 'discard', label: t("放弃修改"), disabled: layout.saving, onClick: layout.discard }] : [])
  ] }}><Button size="small" type="text" aria-label={t("播放器目录选项")} icon={<MoreOutlined />} /></Dropdown>
    {screens.lg && <Tooltip title={t("收起播放器目录")}><Button size="small" type="text" aria-label={t("收起播放器目录")} icon={<CloseOutlined />} onClick={() => setOrganizer(false)} /></Tooltip>}</>;
  const saveControls = (draft || layout.history.future.length > 0) && <div className="music-layout-save"><span>{draft ? t("未保存的修改") : t("已撤销修改")}</span><Space size={4}>
    <Tooltip title={t("撤销")}><Button size="small" icon={<UndoOutlined />} aria-label={t("撤销")} disabled={layout.saving || layout.conflicted || !layout.history.past.length} onClick={layout.undo} /></Tooltip>
    <Tooltip title={t("重做")}><Button size="small" icon={<RedoOutlined />} aria-label={t("重做")} disabled={layout.saving || layout.conflicted || !layout.history.future.length} onClick={layout.redo} /></Tooltip>
    <Button size="small" type="primary" loading={layout.saving} disabled={!draft || layout.conflicted} onClick={() => layout.save()}>{t("保存目录")}</Button>
  </Space></div>;
  function tree(section: 'sources' | 'layout') {
    const contents = <MusicTree key={section + ':' + instances.data?.map(instance => `${instance.id}:${instance.epoch}`).join('|')} api={api} instances={instances.data ?? []} selected={location} open={navigate}
      layout={layout} actions={layoutActions} section={section} views={treeViews} add={copyToLayout} reveal={layoutReveal}
      options={section === 'layout' ? layoutOptions : <Button size="small" type="text" icon={<PlusOutlined />} onClick={add}>{t("添加来源")}</Button>} />;
    return section === 'layout' ? <div className="music-player-pane">{contents}{saveControls}</div> : contents;
  }
  const selectedSourceId = location.target.kind === 'source' ? location.target.instanceId : layoutSource(nodes, location)?.instanceId;
  const selectedSource = instances.data?.find(instance => instance.id === selectedSourceId);
  const missingPlugin = selectedSource && plugins.isSuccess && !plugins.data.some(plugin => plugin.manifest.id === selectedSource.pluginId && plugin.status === 'active');
  return <div className="music-library">{sidebar && screens.md && createPortal(tree('sources'), sidebar)}<div className="music-workspace-toolbar"><Space><Typography.Title level={1}>{t("音乐库")}</Typography.Title>
    <Button className="music-sources-toggle" icon={<MenuOutlined />} onClick={() => showTree('sources')}>{t("来源")}</Button>
  </Space><Space className="music-toolbar-actions"><Button className="music-layout-toggle" type={organizerOpen && screens.lg ? 'default' : 'text'} icon={<PartitionOutlined />} aria-expanded={screens.lg ? organizerOpen : treeOpen && treePanel === 'layout'} onClick={toggleOrganizer}>{t("播放器目录")}{draft && <span className="unsaved-dot" />}</Button>
    <Button type="primary" icon={<LinkOutlined />} loading={layout.saving} disabled={layout.conflicted} onClick={() => draft ? layout.save(showConnection) : showConnection()}>{draft ? t("保存并连接") : t("连接播放器")}</Button>{serviceControl}</Space></div>
    <Failure error={instances.error} retry={() => void instances.refetch()} /><Failure error={remove.error ?? logout.error ?? layout.saveError} />
    <SourceRootsFeedback api={api} error={layout.error} reload={layout.reload} />
    {layout.conflicted && <Alert className="feedback" type="warning" showIcon title={t("目录已在其他窗口更新")} action={<Button onClick={layout.discard}>{t("载入最新目录")}</Button>} />}
    {missingPlugin && <Alert className="feedback" type="info" showIcon title={t("此来源需要安装插件")} action={<Button size="small" onClick={() => showPlugins()}>{t("安装插件")}</Button>} />}
    {instances.isPending ? <Skeleton active /> : instances.isError ? null : !instances.data?.length ? <section className="surface welcome-surface"><div className="welcome-symbol"><FolderOpenOutlined /></div><Typography.Title level={2}>{t("把喜欢的音乐放在一起")}</Typography.Title>
      <Typography.Paragraph type="secondary">{t("连接音乐账号，交给你常用的播放器。")}</Typography.Paragraph><Button type="primary" onClick={add}>{t("添加音乐来源")}</Button></section>
      : <MusicPanes open={!!screens.lg && organizerOpen} layout={tree('layout')} content={layout.loading && location.target.kind === 'layout' ? <Skeleton className="music-content" active /> : <MusicBrowser key={locationKey(location)} api={api} instances={instances.data} location={location} open={navigate} actions={actions} login={login}
          nodes={nodes} views={browserViews} layoutActions={layoutActions} editingDisabled={layout.disabled} add={(instance, roots) => setAdding({ instance, roots })} />} />}
    <Drawer className="music-mobile-tree" title={treePanel === 'layout' ? t("播放器目录") : t("音乐来源")} open={treeOpen} onClose={() => setTreeOpen(false)} placement={treePanel === 'layout' ? 'right' : 'left'} size={320} destroyOnHidden>{tree(treePanel)}</Drawer>
    {adding && <AddToFolder nodes={nodes} initial={parentId} names={adding.roots.map(root => root.name)} close={() => setAdding(null)} add={(parent, folderName) => {
      copyToLayout(sourceDrag(adding.instance.id, adding.roots), parent, folderName); setAdding(null);
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
  </div>;
}
