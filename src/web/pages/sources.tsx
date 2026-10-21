import { lazy, Suspense, useState } from 'react';
import { App, Button, Drawer, Empty, Input, Modal, Select, Skeleton, Space, Tag, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from 'react-error-boundary';
import type { Json } from '@musicfs/plugin-api';
import type { SourceInstance } from '../../contracts/management';
import type { Api } from '../api';
import { Failure } from '../components/feedback';
import { pendingRefreshId, RefreshProgress, usePersistentRefresh } from '../components/refresh';
import { RefreshPolicyControl } from '../components/refresh-policy';

const SchemaForm = lazy(() => import('../components/schema-form'));
const Authentication = lazy(() => import('../components/authentication'));

export default function Sources({ api, showPlugins }: { api: Api; showPlugins: () => void }) {
  const client = useQueryClient(); const { modal, message } = App.useApp();
  const instances = useQuery({ queryKey: ['instances'], queryFn: ({ signal }) => api.instances(signal) });
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: ({ signal }) => api.plugins(signal) });
  const [editing, setEditing] = useState<SourceInstance | 'create' | null>(null);
  const [inspecting, setInspecting] = useState<SourceInstance | null>(null);
  const [authenticating, setAuthenticating] = useState<{ instance: SourceInstance; needsReauthorization: boolean } | null>(null);
  const activePlugins = plugins.data?.filter(value => value.status === 'active') ?? [];
  const capabilities = useQueries({ queries: activePlugins.map(plugin => ({ queryKey: ['configuration', plugin.manifest.id], queryFn: ({ signal }: { signal: AbortSignal }) => api.configuration(plugin.manifest.id, signal) })) });
  const withAuthentication = new Set(activePlugins.filter((_plugin, index) => capabilities[index]?.data?.authentication).map(plugin => plugin.manifest.id));
  const remove = useMutation({ mutationFn: (id: string) => api.deleteInstance(id), onSuccess: async () => {
    await client.invalidateQueries({ queryKey: ['instances'] }); await client.invalidateQueries({ queryKey: ['library'] });
    await client.invalidateQueries({ queryKey: ['directory-status'] }); message.success('实例已删除');
  } });
  const logout = useMutation({ mutationFn: (id: string) => api.logoutInstance(id), onSuccess: async (_value, id) => {
    setAuthenticating(current => current?.instance.id === id ? null : current);
    setInspecting(current => current?.id === id ? null : current);
    for (const key of ['authentication', 'authentication-poll', 'roots', 'directory-status', 'refresh-current']) {
      await client.cancelQueries({ queryKey: [key, id] });
      client.removeQueries({ queryKey: [key, id] });
    }
    await client.resetQueries({ queryKey: ['library'] });
    await client.invalidateQueries({ queryKey: ['instances'] });
    message.success('已退出此实例授权；配置和目录布局已保留，请重新授权后使用。');
  } });
  return <>
    <div className="page-actions"><span>{instances.data?.length ?? 0} 个独立实例</span><Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('create')}>添加数据源</Button></div>
    <Failure error={instances.error} retry={() => void instances.refetch()} /><Failure error={plugins.error} /><Failure error={remove.error} /><Failure error={logout.error} />
    {instances.isPending ? <Skeleton active /> : !instances.isError && !instances.data?.length ? <section className="surface"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<div><Typography.Title level={3}>从一个数据源开始</Typography.Title><p>先安装来源插件，再为它创建独立实例。</p></div>}><Button onClick={showPlugins}>前往插件</Button></Empty></section> :
      <div className="instance-list">{instances.data?.map(instance => {
        const plugin = plugins.data?.find(value => value.manifest.id === instance.pluginId); const available = plugin?.status === 'active';
        return <article className="surface instance-row" key={instance.id}><div className="instance-identity"><Typography.Title level={3}>{instance.name}</Typography.Title>
          <Typography.Text type="secondary">{plugin?.manifest.name ?? instance.pluginId}</Typography.Text><div className="secondary-id">{instance.id}</div></div>
          <div className="instance-actions"><Tag color={available ? 'success' : 'default'}>{available ? '插件可用' : '等待重装插件'}</Tag><Space wrap>
            <Button disabled={!available} onClick={() => setInspecting(instance)}>内容源</Button><Button disabled={!available} onClick={() => setEditing(instance)}>配置</Button>
            {withAuthentication.has(instance.pluginId) && <><Button disabled={logout.isPending && logout.variables === instance.id} onClick={() => setAuthenticating({ instance, needsReauthorization: false })}>授权</Button>
              <Button disabled={logout.isPending || remove.isPending} onClick={() => modal.confirm({ title: `退出“${instance.name}”的授权？`,
                content: '将清除此实例保存的授权，并停止后续读取。实例配置和目录布局会保留，重新授权后可继续使用；其他实例不受影响。',
                okText: '退出授权', cancelText: '保留授权', onOk: () => logout.mutateAsync(instance.id) })}>退出授权</Button></>}
            <Button type="text" danger disabled={remove.isPending} onClick={() => modal.confirm({ title: `删除实例“${instance.name}”？`, content: '此实例的配置、授权和缓存将删除。其他实例不受影响；目录布局中的引用会保留为失效引用。', okText: '删除实例', okButtonProps: { danger: true }, cancelText: '取消', onOk: () => remove.mutateAsync(instance.id) })}>删除</Button>
          </Space></div></article>;
      })}</div>}
    {editing && <InstanceEditor api={api} instance={editing === 'create' ? undefined : editing} close={() => setEditing(null)} showPlugins={() => { setEditing(null); showPlugins(); }} />}
    <Drawer title={inspecting ? `${inspecting.name} · 内容源` : '内容源'} open={inspecting !== null} onClose={() => setInspecting(null)} size="large" destroyOnHidden>{inspecting && <Roots api={api} instance={inspecting}
      reauthorize={withAuthentication.has(inspecting.pluginId) ? () => setAuthenticating({ instance: inspecting, needsReauthorization: true }) : undefined} />}</Drawer>
    {authenticating && <Suspense fallback={<Skeleton active />}><Authentication api={api} instance={authenticating.instance} needsReauthorization={authenticating.needsReauthorization} close={() => setAuthenticating(null)} /></Suspense>}
  </>;
}

function InstanceEditor({ api, instance, close, showPlugins }: { api: Api; instance: SourceInstance | undefined; close: () => void; showPlugins: () => void }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const [pluginId, setPluginId] = useState(instance?.pluginId ?? ''); const [name, setName] = useState(instance?.name ?? '');
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: ({ signal }) => api.plugins(signal) });
  const configuration = useQuery({ queryKey: ['configuration', pluginId], queryFn: ({ signal }) => api.configuration(pluginId, signal), enabled: !!pluginId });
  const save = useMutation({ mutationFn: async (config: Json) => {
    if (!name.trim()) throw new Error('请输入实例名称');
    return instance ? api.configure(instance.id, config) : api.createInstance(pluginId, name.trim(), config);
  }, onSuccess: async () => {
    await client.invalidateQueries({ queryKey: ['instances'] }); await client.invalidateQueries({ queryKey: ['roots'] });
    await client.invalidateQueries({ queryKey: ['library'] }); await client.invalidateQueries({ queryKey: ['directory-status'] });
    message.success(instance ? '配置已保存' : '实例已创建'); close();
  } });
  const available = plugins.data?.filter(plugin => plugin.status === 'active') ?? [];
  return <Modal title={instance ? `${instance.name} · 配置` : '添加独立数据源'} open onCancel={() => { if (!save.isPending) close(); }} footer={null} width={600} destroyOnHidden mask={{ closable: !save.isPending }} closable={!save.isPending}>
    {!plugins.isPending && !available.length ? <Empty description="请先安装一个来源插件"><Button onClick={showPlugins}>前往插件</Button></Empty> : <>
      <div className="field-block"><label htmlFor="source-plugin">来源插件</label><Select<string> id="source-plugin" value={pluginId || null} placeholder="选择已安装插件" disabled={!!instance || save.isPending} onChange={id => { setPluginId(id); save.reset(); }} options={available.map(plugin => ({ value: plugin.manifest.id, label: `${plugin.manifest.name} · ${plugin.manifest.version}` }))} /></div>
      <div className="field-block"><label htmlFor="instance-name">实例名称</label><Input id="instance-name" value={name} maxLength={120} disabled={!!instance || save.isPending} placeholder="例如：个人收藏、家庭音乐" onChange={event => setName(event.target.value)} /></div>
      <Failure error={plugins.error} /><Failure error={configuration.error} retry={() => void configuration.refetch()} /><Failure error={save.error} />
      {configuration.isFetching && <Skeleton active />}{configuration.data && <ErrorBoundary key={pluginId} fallbackRender={() => <Failure error={new Error('无法显示此插件的配置表单，请检查插件版本或联系作者。')} />}><Suspense fallback={<Skeleton active />}><SchemaForm configuration={configuration.data.configuration} value={instance?.config ?? {}} pending={save.isPending} error={save.error} onSubmit={config => save.mutate(config)} /></Suspense></ErrorBoundary>}
      {configuration.data?.authentication && <p className="page-footnote">此来源的授权与配置分别保存。保存后可在数据源列表中打开“授权”。</p>}
    </>}
  </Modal>;
}

function Roots({ api, instance, reauthorize }: { api: Api; instance: SourceInstance; reauthorize?: (() => void) | undefined }) {
  const { message } = App.useApp();
  const roots = useQuery({ queryKey: ['roots', instance.id, instance.epoch], queryFn: ({ signal }) => api.roots(instance.id, signal), retry: false });
  const pending = pendingRefreshId(roots.error);
  const configuration = useQuery({ queryKey: ['configuration', instance.pluginId], queryFn: ({ signal }) => api.configuration(instance.pluginId, signal) });
  const statuses = useQueries({ queries: (roots.data ?? []).map(root => ({ queryKey: ['directory-status', instance.id, instance.epoch, root.directoryRef],
    queryFn: ({ signal }: { signal: AbortSignal }) => api.directoryStatus(instance.id, root.directoryRef, signal) })) });
  const refresh = usePersistentRefresh(api, { instanceId: instance.id, operationId: pending, onCompleted: result => {
    if (result.failures.length) message.warning(`${result.failures.length} 个目录刷新失败，请查看下方详情`);
    else message.success(result.scope.kind === 'file-info' ? '文件已准备'
      : result.scope.kind === 'instance' ? `实例清单已更新（${result.refreshedDirectories} 个目录）`
      : result.scope.directoryRef === undefined ? '内容入口已更新' : '清单已更新');
  } });
  const busy = refresh.active || refresh.starting || refresh.preparing || roots.isFetching;
  return <><div className="page-actions"><Typography.Text type="secondary">可添加到目录布局的内容入口</Typography.Text><Button icon={<ReloadOutlined />} loading={refresh.starting || refresh.active && refresh.view?.scope.kind === 'instance'} disabled={busy} onClick={() => refresh.start({ kind: 'instance' })}>刷新实例内容</Button></div>
    <p className="page-footnote">刷新各内容入口及已浏览的子目录；新子目录首次打开时加载。刷新失败的目录保留上次成功内容。</p>
    <Failure error={pending ? null : roots.error} retry={() => void roots.refetch()} reauthorize={reauthorize} /><Failure error={configuration.error} />
    <RefreshProgress operation={refresh} labels={configuration.data?.statistics} reload={() => refresh.view && refresh.start(refresh.view.scope)} reauthorize={reauthorize} />
    {roots.isPending ? <Skeleton active /> : roots.data?.length ? roots.data.map((root, index) => <div className="root-row" key={root.sourceId}><div><Typography.Text strong>{root.name}</Typography.Text><div className="secondary-id">{root.sourceId}</div>
      {statuses[index]?.data && <><div className="directory-statistics">{Object.entries(configuration.data?.statistics ?? {}).flatMap(([key, label]) => {
        const count = statuses[index]?.data?.statistics?.[key]; return count === undefined ? [] : [<span key={key}>{label} <strong>{count}</strong></span>];
      })}</div>{statuses[index]!.data!.error && <div role="alert"><Typography.Text type="warning">刷新失败，保留最近成功内容</Typography.Text></div>}
        {(statuses[index]!.data!.pendingFileInfo ?? 0) > 0 && <div><Typography.Text type="secondary">目录清单已就绪，可按需读取单个文件。使用 App 挂载或全库扫描前，请先准备文件，完成后再连接客户端。</Typography.Text></div>}
        <div className="secondary-id">最近成功：{new Date(statuses[index]!.data!.completedAt).toLocaleString()}</div></>}
      <Failure error={statuses[index]?.error ?? null} />
    </div>
      <Space wrap>
        <RefreshPolicyControl api={api} instanceId={instance.id} directoryRef={root.directoryRef} disabled={busy} />
        {(statuses[index]?.data?.pendingFileInfo ?? 0) > 0 && <Button size="small" disabled={busy} loading={refresh.active && refresh.view?.scope.kind === 'file-info' && refresh.view.scope.directoryRef === root.directoryRef} onClick={() => refresh.start({ kind: 'file-info', directoryRef: root.directoryRef })}>准备文件</Button>}
        <Button size="small" icon={<ReloadOutlined />} disabled={busy} loading={refresh.active && refresh.view?.scope.kind === 'directory' && refresh.view.scope.directoryRef === root.directoryRef} onClick={() => refresh.start({ kind: 'directory', directoryRef: root.directoryRef })}>刷新目录</Button>
      </Space>
    </div>) : !roots.isError && <Empty description="此实例暂时没有内容源" />}
  </>;
}
