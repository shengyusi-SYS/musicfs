import { lazy, Suspense, useState } from 'react';
import { Alert, App, Button, Drawer, Dropdown, Skeleton, Space, Typography } from 'antd';
import { FolderOpenOutlined, LinkOutlined, MoreOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SourceInstance } from '../../contracts/management';
import type { Api } from '../api';
import { Failure } from '../components/feedback';
import { SourceEditor } from '../components/source-editor';
import { MusicInspector } from '../components/music-inspector';
import { MusicTree } from '../components/music-tree';
import { MusicBrowser } from '../components/music-browser';
import { exportedMusic, locationKey, sourceLocation, useMusicNavigation } from '../components/music-navigation';
import { LayoutEditor, type LayoutDraft } from './layout-editor';
import './music-workspace.css';

const Authentication = lazy(() => import('../components/authentication'));
type Panel = { kind: 'create' } | { kind: 'settings'; instance: SourceInstance; directoryRef?: string | undefined; label: string };
export default function MusicWorkspace({ api, showPlugins, showConnection, initialPluginId, consumePlugin, draft, setDraft }: {
  api: Api; showPlugins(): void; showConnection(): void; initialPluginId: string | null; consumePlugin(): void;
  draft: LayoutDraft | null; setDraft(draft: LayoutDraft | null): void;
}) {
  const client = useQueryClient(); const { modal, message } = App.useApp();
  const instances = useQuery({ queryKey: ['instances'], queryFn: ({ signal }) => api.instances(signal) });
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: ({ signal }) => api.plugins(signal) });
  const { location, open } = useMusicNavigation();
  const [organizing, setOrganizing] = useState(false); const [treeOpen, setTreeOpen] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(() => initialPluginId ? { kind: 'create' } : null);
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
  function add() { if (plugins.data && !plugins.data.some(plugin => plugin.status === 'active')) showPlugins(); else setPanel({ kind: 'create' }); }
  function closePanel() { setPanel(null); consumePlugin(); }
  function navigate(next: typeof location) { open(next); setTreeOpen(false); closePanel(); }
  function login(instance: SourceInstance) { setAuthenticating({ instance, needsReauthorization: true }); }
  function actions(source: { instanceId: string; directoryRef?: string }, authentication: boolean, metadata: { disabled: boolean; run(): void } | null) {
    const instance = instances.data?.find(value => value.id === source.instanceId);
    const scope = { ...source, label: source.directoryRef === undefined ? instance?.name ?? location.name : location.name };
    const items = [
      ...(metadata ? [{ key: 'metadata', label: '重新获取音乐资料', disabled: metadata.disabled, onClick: metadata.run }] : []),
      ...(instance ? [
        ...(authentication ? [{ key: 'login', label: '登录账号', onClick: () => login(instance) },
          { key: 'logout', label: '退出账号', disabled: logout.isPending, onClick: () => logout.mutate(instance.id) }] : []),
        ...(source.directoryRef === undefined ? [{ key: 'delete', label: '删除来源', danger: true, disabled: remove.isPending, onClick: () => modal.confirm({
          title: '删除 ' + instance.name + '？', content: '删除此来源的配置与登录信息。', okText: '删除', okButtonProps: { danger: true }, cancelText: '取消', onOk: () => remove.mutateAsync(instance.id)
        }) }] : [])] : [])
    ];
    return <Space>{instance && <Button icon={<SettingOutlined />} onClick={() => setPanel({ kind: 'settings', instance, directoryRef: scope.directoryRef, label: scope.label })}>设置</Button>}
      {!!items.length && <Dropdown trigger={['click']} menu={{ items }}><Button icon={<MoreOutlined />} aria-label="当前内容的更多操作" /></Dropdown>}
    </Space>;
  }
  const tree = <MusicTree key={instances.data?.map(instance => `${instance.id}:${instance.epoch}`).join('|')} api={api} instances={instances.data ?? []} selected={location} open={navigate} />;
  const selectedSourceId = location.target.kind === 'source' ? location.target.instanceId : undefined;
  const selectedSource = instances.data?.find(instance => instance.id === selectedSourceId);
  const missingPlugin = selectedSource && plugins.isSuccess && !plugins.data.some(plugin => plugin.manifest.id === selectedSource.pluginId && plugin.status === 'active');
  return <>{!organizing && <div className="music-workspace-toolbar"><Button icon={<PlusOutlined />} onClick={add}>添加来源</Button><Space>
    <Button icon={<FolderOpenOutlined />} onClick={() => setOrganizing(true)}>整理目录{draft && <span className="unsaved-dot" />}</Button>
    <Button type="primary" icon={<LinkOutlined />} onClick={showConnection}>连接播放器</Button>
  </Space></div>}
    <Failure error={instances.error} retry={() => void instances.refetch()} /><Failure error={remove.error ?? logout.error} />
    {missingPlugin && <Alert className="feedback" type="info" showIcon title="此来源需要安装插件" action={<Button size="small" onClick={showPlugins}>安装插件</Button>} />}
    {organizing ? <LayoutEditor api={api} draft={draft} setDraft={setDraft} close={() => setOrganizing(false)} saved={() => { open(exportedMusic); setOrganizing(false); }} showSources={() => { setOrganizing(false); add(); }} />
      : instances.isPending ? <Skeleton active /> : instances.isError ? null : !instances.data?.length ? <section className="surface welcome-surface"><div className="welcome-symbol"><FolderOpenOutlined /></div><Typography.Title level={2}>把喜欢的音乐放在一起</Typography.Title>
        <Typography.Paragraph type="secondary">连接音乐账号，交给你常用的播放器。</Typography.Paragraph><Button type="primary" onClick={add}>添加音乐来源</Button></section>
      : <div className="music-workspace"><aside className="music-explorer">{tree}</aside>
        <MusicBrowser key={locationKey(location)} api={api} instances={instances.data} location={location} open={navigate} showTree={() => setTreeOpen(true)} actions={actions} login={login} organize={() => setOrganizing(true)} />
      </div>}
    <Drawer className="music-mobile-tree" title="音乐库" open={treeOpen} onClose={() => setTreeOpen(false)} placement="left" size={320} destroyOnHidden>{tree}</Drawer>
    {panel?.kind === 'create' && <SourceEditor api={api} initialPluginId={initialPluginId} close={closePanel}
      showPlugins={() => { closePanel(); showPlugins(); }} saved={(instance, authenticate) => { closePanel(); open(sourceLocation(instance)); if (authenticate) setAuthenticating({ instance, needsReauthorization: false }); }} />}
    {panel?.kind === 'settings' && <MusicInspector key={panel.instance.id + ':' + panel.directoryRef} api={api} instance={panel.instance} directoryRef={panel.directoryRef} label={panel.label} close={closePanel}
      showPlugins={() => { closePanel(); showPlugins(); }} />}
    {authenticating && <Suspense fallback={<Skeleton active />}><Authentication api={api} instance={authenticating.instance} needsReauthorization={authenticating.needsReauthorization} close={() => setAuthenticating(null)}
      done={() => { open(sourceLocation(authenticating.instance)); setAuthenticating(null); }} /></Suspense>}
  </>;
}
