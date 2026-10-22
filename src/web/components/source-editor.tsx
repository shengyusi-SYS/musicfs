import { lazy, Suspense, useState } from 'react';
import { App, Button, Drawer, Empty, Input, Select, Skeleton } from 'antd';
import { ErrorBoundary } from 'react-error-boundary';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Json } from '@musicfs/plugin-api';
import type { SourceInstance } from '../../contracts/management';
import { ApiError, type Api } from '../api';
import { Failure } from './feedback';

const SchemaForm = lazy(() => import('./schema-form'));

type SourceSettingsProps = {
  api: Api; instance?: SourceInstance; initialPluginId?: string | null; close: () => void; showPlugins: () => void;
  saved: (instance: SourceInstance, authenticate: boolean) => void;
};
export function SourceEditor(props: SourceSettingsProps) {
  return <Drawer title={props.instance ? props.instance.name + ' · 设置' : '添加音乐来源'} open onClose={props.close} size={560} destroyOnHidden>
    <SourceSettings {...props} />
  </Drawer>;
}
export function SourceSettings({ api, instance, initialPluginId, close, showPlugins, saved }: SourceSettingsProps) {
  const client = useQueryClient(); const { message } = App.useApp();
  const [selected, setSelected] = useState(instance?.pluginId ?? initialPluginId ?? '');
  const [name, setName] = useState<string | undefined>(instance?.name);
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: ({ signal }) => api.plugins(signal) });
  const available = plugins.data?.filter(plugin => plugin.status === 'active') ?? [];
  const pluginId = selected || (available.length === 1 ? available[0]!.manifest.id : '');
  const plugin = available.find(value => value.manifest.id === pluginId);
  const displayName = name ?? plugin?.manifest.name ?? '';
  const configuration = useQuery({ queryKey: ['configuration', pluginId], queryFn: ({ signal }) => api.configuration(pluginId, signal), enabled: !!pluginId });
  const save = useMutation({ mutationFn: async (config: Json) => {
    if (!displayName.trim()) throw new Error('请为这个来源起个名字');
    const result = instance ? await api.configure(instance.id, config) : await api.createInstance(pluginId, displayName.trim(), config);
    if (!result.ok) throw new ApiError(422, { error: result.error });
    return instance ?? result.value as SourceInstance;
  }, onSuccess: async value => {
    await Promise.all(['instances', 'roots', 'library', 'directory-status'].map(key => client.invalidateQueries({ queryKey: [key] })));
    if (instance) { message.success('设置已保存'); close(); }
    else saved(value, !!configuration.data?.authentication);
  } });
  const nameField = <div className="field-block"><label htmlFor="instance-name">显示名称</label><Input id="instance-name" value={displayName} maxLength={120} disabled={save.isPending} onChange={event => setName(event.target.value)} /></div>;
  return <>
    {plugins.isPending ? <Skeleton active /> : !plugins.isError && !available.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先安装一个来源插件"><Button type="primary" onClick={showPlugins}>安装插件</Button></Empty> : <>
      {!instance && !initialPluginId && available.length > 1 && <div className="field-block"><label htmlFor="source-plugin">音乐来源</label><Select<string> id="source-plugin" value={pluginId || null} placeholder="选择来源插件" disabled={save.isPending} onChange={id => { setSelected(id); setName(undefined); save.reset(); }} options={available.map(value => ({ value: value.manifest.id, label: value.manifest.name }))} /></div>}
      {!instance && plugin && nameField}
      <Failure error={plugins.error} retry={() => void plugins.refetch()} /><Failure error={configuration.error} retry={() => void configuration.refetch()} /><Failure error={save.error} />
      {configuration.isPending && pluginId && <Skeleton active />}
      {configuration.data && <ErrorBoundary key={pluginId} fallbackRender={() => <Failure error={new Error('配置表单未能加载，请检查插件版本。')} />}><Suspense fallback={<Skeleton active />}>
        <SchemaForm configuration={configuration.data.configuration} value={instance?.config ?? {}} pending={save.isPending} error={save.error}
          submitLabel={instance ? '保存' : configuration.data.authentication ? '添加并登录' : '添加来源'} onSubmit={config => save.mutate(config)} />
      </Suspense></ErrorBoundary>}
    </>}
  </>;
}
