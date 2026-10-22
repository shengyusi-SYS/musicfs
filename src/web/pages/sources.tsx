import { lazy, Suspense, useState } from 'react';
import { App, Button, Drawer, Dropdown, Skeleton, Tag, Typography } from 'antd';
import { ArrowRightOutlined, MoreOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SourceInstance } from '../../contracts/management';
import type { Api } from '../api';
import { Failure } from '../components/feedback';
import { SourceEditor } from '../components/source-editor';
import { SourceContent } from '../components/source-content';
import { UpdateRuleControlDialog } from '../components/update-rule-editor';
import { FileNamingEditor } from '../components/file-naming';

const Authentication = lazy(() => import('../components/authentication'));

export default function Sources({ api, showPlugins, showLibrary, initialPluginId, consumePlugin }: {
  api: Api; showPlugins: () => void; showLibrary: () => void; initialPluginId: string | null; consumePlugin: () => void;
}) {
  const client = useQueryClient(); const { modal, message } = App.useApp();
  const instances = useQuery({ queryKey: ['instances'], queryFn: ({ signal }) => api.instances(signal) });
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: ({ signal }) => api.plugins(signal) });
  const [editing, setEditing] = useState<SourceInstance | 'create' | null>(() => initialPluginId ? 'create' : null);
  const [updating, setUpdating] = useState<SourceInstance | null>(null);
  const [naming, setNaming] = useState<SourceInstance | null>(null);
  const [inspecting, setInspecting] = useState<SourceInstance | null>(null);
  const [authenticating, setAuthenticating] = useState<{ instance: SourceInstance; needsReauthorization: boolean } | null>(null);
  const activePlugins = plugins.data?.filter(value => value.status === 'active' && instances.data?.some(instance => instance.pluginId === value.manifest.id)) ?? [];
  const capabilities = useQueries({ queries: activePlugins.map(plugin => ({ queryKey: ['configuration', plugin.manifest.id], queryFn: ({ signal }: { signal: AbortSignal }) => api.configuration(plugin.manifest.id, signal) })) });
  const withAuthentication = new Set(activePlugins.filter((_plugin, index) => capabilities[index]?.data?.authentication).map(plugin => plugin.manifest.id));
  const remove = useMutation({ mutationFn: (id: string) => api.deleteInstance(id), onSuccess: async () => {
    await Promise.all(['instances', 'library', 'directory-status', 'roots'].map(key => client.invalidateQueries({ queryKey: [key] }))); message.success('来源已删除');
  } });
  const logout = useMutation({ mutationFn: (id: string) => api.logoutInstance(id), onSuccess: async (_value, id) => {
    setAuthenticating(current => current?.instance.id === id ? null : current);
    setInspecting(current => current?.id === id ? null : current);
    for (const key of ['authentication', 'authentication-poll', 'roots', 'directory-status', 'refresh-current']) {
      await client.cancelQueries({ queryKey: [key, id] }); client.removeQueries({ queryKey: [key, id] });
    }
    await client.resetQueries({ queryKey: ['library'] }); await client.invalidateQueries({ queryKey: ['instances'] }); message.success('已退出登录');
  } });
  function closeEditor() { setEditing(null); consumePlugin(); }
  function add() { if (plugins.isSuccess && !plugins.data.some(plugin => plugin.status === 'active')) showPlugins(); else setEditing('create'); }
  return <>{!!instances.data?.length && <div className="page-actions"><Typography.Text type="secondary">{instances.data.length + ' 个音乐来源'}</Typography.Text>
    <Button type="primary" icon={<PlusOutlined aria-hidden="true" />} onClick={add}>添加音乐来源</Button></div>}
    <Failure error={instances.error} retry={() => void instances.refetch()} /><Failure error={plugins.error} /><Failure error={remove.error} /><Failure error={logout.error} />
    {instances.isPending ? <Skeleton active /> : !instances.isError && !instances.data?.length ? <section className="surface welcome-surface"><WelcomeIcon />
      <Typography.Title level={2}>从喜欢的音乐开始</Typography.Title><Typography.Paragraph type="secondary">连接音乐账号，把歌单交给你常用的播放器。</Typography.Paragraph>
      <Button type="primary" size="large" icon={<PlusOutlined aria-hidden="true" />} disabled={plugins.isPending} onClick={add}>添加第一个来源</Button>
    </section> : <section className="surface instance-list">{instances.data?.map(instance => {
      const plugin = plugins.data?.find(value => value.manifest.id === instance.pluginId); const available = plugin?.status === 'active';
      return <article className="instance-row" key={instance.id}><div className="source-avatar" aria-hidden="true">{instance.name.slice(0, 1)}</div>
        <div className="instance-identity"><button className="source-name" disabled={!available} onClick={() => setInspecting(instance)}>{instance.name}</button>{plugin?.manifest.name !== instance.name && <div className="secondary-id">{plugin?.manifest.name ?? instance.pluginId}</div>}</div>
        <div className="instance-actions">{!available && <Tag>需要安装插件</Tag>}<Button disabled={!available} icon={<ArrowRightOutlined aria-hidden="true" />} onClick={() => setInspecting(instance)}>浏览内容</Button>
          <Dropdown trigger={['click']} menu={{ items: [
            { key: 'settings', label: '来源设置', disabled: !available, onClick: () => setEditing(instance) },
            { key: 'update-rule', label: '自动更新', disabled: !available, onClick: () => setUpdating(instance) },
            { key: 'file-naming', label: '文件命名', disabled: !available, onClick: () => setNaming(instance) },
            ...(withAuthentication.has(instance.pluginId) ? [
              { key: 'login', label: '重新登录', onClick: () => setAuthenticating({ instance, needsReauthorization: true }) },
              { key: 'logout', label: '退出登录', disabled: logout.isPending, onClick: () => modal.confirm({ title: '退出 ' + instance.name + '？', content: '重新登录后可继续读取，目录和设置会保留。', okText: '退出登录', cancelText: '取消', onOk: () => logout.mutateAsync(instance.id) }) }
            ] : []),
            { type: 'divider' }, { key: 'delete', label: '删除来源', danger: true, disabled: remove.isPending, onClick: () => modal.confirm({ title: '删除 ' + instance.name + '？', content: '将删除此来源的设置、登录信息和缓存。', okText: '删除', okButtonProps: { danger: true }, cancelText: '取消', onOk: () => remove.mutateAsync(instance.id) }) }
          ] }}><Button type="text" icon={<MoreOutlined aria-hidden="true" />} aria-label={instance.name + '的更多操作'} /></Dropdown>
        </div></article>;
    })}</section>}
    {updating && <UpdateRuleControlDialog api={api} instanceId={updating.id} label={updating.name} close={() => setUpdating(null)} />}
    {naming && <FileNamingEditor api={api} instanceId={naming.id} label={naming.name} close={() => setNaming(null)} />}
    {editing && <SourceEditor api={api} {...(editing !== 'create' ? { instance: editing } : {})} initialPluginId={initialPluginId} close={closeEditor}
      showPlugins={() => { closeEditor(); showPlugins(); }} saved={(instance, authenticate) => { closeEditor(); if (authenticate) setAuthenticating({ instance, needsReauthorization: false }); else setInspecting(instance); }} />}
    <Drawer title={inspecting?.name ?? '浏览内容'} open={inspecting !== null} onClose={() => setInspecting(null)} size="large" destroyOnHidden>{inspecting && <SourceContent api={api} instance={inspecting}
      showLibrary={showLibrary} reauthorize={withAuthentication.has(inspecting.pluginId) ? () => setAuthenticating({ instance: inspecting, needsReauthorization: true }) : undefined} />}</Drawer>
    {authenticating && <Suspense fallback={<Skeleton active />}><Authentication api={api} instance={authenticating.instance} needsReauthorization={authenticating.needsReauthorization}
      close={() => setAuthenticating(null)} done={() => { setInspecting(authenticating.instance); setAuthenticating(null); }} /></Suspense>}
  </>;
}

function WelcomeIcon() { return <div className="welcome-symbol" aria-hidden="true"><PlusOutlined aria-hidden="true" /></div>; }
