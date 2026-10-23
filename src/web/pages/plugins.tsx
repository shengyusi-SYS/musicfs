import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Collapse, Descriptions, Dropdown, Empty, Skeleton, Typography } from 'antd';
import { AppstoreOutlined, MoreOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type Api } from '../api';
import { Failure } from '../components/feedback';
import { PluginInstaller } from '../components/plugin-installer';
import type { PluginChange } from '../../contracts/plugin-changes';
import type { PluginInstallation } from '../../contracts/management';

const changeLabels: Record<PluginChange['status'], string> = { queued: '等待安装', preparing: '正在准备', uploading: '正在上传', deploying: '正在发布', verifying: '即将完成', migrating: '正在更新来源数据', completed: '已完成', failed: '未完成' };

export default function Plugins({ api, addSource, startInstalling, addAfterInstall, consumeInstall }: { api: Api; addSource: (pluginId: string) => void; startInstalling: boolean; addAfterInstall: boolean; consumeInstall: () => void }) {
  const client = useQueryClient(); const { modal, message } = App.useApp();
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: ({ signal }) => api.plugins(signal) });
  const [operationId, setOperationId] = useState(() => sessionStorage.getItem('musicfs.pluginChange'));
  const [changeError, setChangeError] = useState(''); const handled = useRef<string | null>(null);
  const [installing, setInstalling] = useState(startInstalling);
  const [continueAdding, setContinueAdding] = useState(startInstalling && addAfterInstall);
  useEffect(() => { if (startInstalling) consumeInstall(); }, []);
  const change = useQuery({ queryKey: ['plugin-change', operationId], enabled: !!operationId,
    queryFn: ({ signal }) => api.pluginChange(operationId!, signal),
    refetchInterval: query => query.state.data?.status === 'completed' || query.state.data?.status === 'failed' ? false : 1500 });
  async function invalidate() { await Promise.all(['plugins', 'instances', 'configuration', 'authentication', 'refresh-current', 'roots', 'library', 'directory-status'].map(key => client.invalidateQueries({ queryKey: [key] }))); }
  function follow(value: PluginChange, add = false) {
    setChangeError(''); sessionStorage.setItem('musicfs.pluginChange', value.operationId);
    if (add) sessionStorage.setItem('musicfs.pluginChange.addSource', value.operationId);
    else sessionStorage.removeItem('musicfs.pluginChange.addSource');
    setOperationId(value.operationId);
  }
  function clearOperation() { sessionStorage.removeItem('musicfs.pluginChange'); sessionStorage.removeItem('musicfs.pluginChange.addSource'); setOperationId(null); }
  useEffect(() => {
    if (change.error instanceof ApiError && change.error.status === 404) {
      clearOperation(); void invalidate();
    }
  }, [change.error]);
  useEffect(() => {
    const value = change.data;
    if (!value || value.status !== 'completed' && value.status !== 'failed' || handled.current === value.operationId) return;
    let active = true;
    void (async () => {
      if (value.status === 'completed') await invalidate();
      if (!active) return;
      handled.current = value.operationId;
      const add = value.kind === 'install' && sessionStorage.getItem('musicfs.pluginChange.addSource') === value.operationId;
      clearOperation();
      if (value.status === 'failed') setChangeError(value.error?.message ?? '安装未完成，请重试');
      else if (add) addSource(value.pluginId);
      else message.success(value.kind === 'remove' ? '插件已移除' : '插件已安装');
    })();
    return () => { active = false; };
  }, [change.data]);
  async function installed(value: PluginInstallation | PluginChange) {
    setInstalling(false);
    if ('operationId' in value) follow(value, continueAdding);
    else { await invalidate(); if (continueAdding) addSource(value.manifest.id); else message.success('已安装 ' + value.manifest.name); }
    setContinueAdding(false);
  }
  const remove = useMutation({ mutationFn: (id: string) => api.removePlugin(id), onSuccess: async value => {
    if (value) follow(value); else { await invalidate(); message.success('插件已移除'); }
  } });
  const busy = !!operationId || remove.isPending;
  function install() { setContinueAdding(false); setInstalling(true); }
  return <><div className="page-actions"><Typography.Text type="secondary">为 MusicFS 接入更多音乐来源</Typography.Text><Button type="primary" disabled={busy} icon={<PlusOutlined aria-hidden="true" />} onClick={install}>安装插件</Button></div>
    {operationId && <Alert className="feedback" type="info" showIcon title={change.data ? changeLabels[change.data.status] : '正在查询安装进度'} />}
    {changeError && <Alert className="feedback" type="error" showIcon title={changeError} closable onClose={() => setChangeError('')} />}
    <Failure error={change.error} retry={() => void change.refetch()} /><Failure error={plugins.error} retry={() => void plugins.refetch()} /><Failure error={remove.error} />
    <section className="surface plugin-list">{plugins.isPending ? <div className="loading-surface"><Skeleton active /></div> : !plugins.isError && !plugins.data?.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="安装来源插件，开始连接音乐账号" /> : plugins.data?.map(item => <article className="plugin-row" key={item.manifest.id}>
      <div className="plugin-row-main"><div className="source-avatar"><AppstoreOutlined aria-hidden="true" /></div><div className="instance-identity"><Typography.Text strong>{item.manifest.name}</Typography.Text><div className="secondary-id">{item.manifest.version}{item.status !== 'active' && ' · 已移除'}</div></div>
        <div className="instance-actions">{item.status === 'active' && <Button disabled={busy} onClick={() => addSource(item.manifest.id)}>添加来源</Button>}
          <Dropdown trigger={['click']} menu={{ items: [
            { key: 'update', label: item.status === 'active' ? '更新插件' : '重新安装', disabled: busy, onClick: install },
            ...(item.status === 'active' ? [{ key: 'remove', label: '移除插件', danger: true, disabled: busy, onClick: () => modal.confirm({ title: '移除 ' + item.manifest.name + '？', content: '相关来源将暂停读取，重新安装后可恢复。', okText: '移除', cancelText: '取消', onOk: () => remove.mutateAsync(item.manifest.id) }) }] : [])
          ] }}><Button type="text" icon={<MoreOutlined aria-hidden="true" />} aria-label={item.manifest.name + '的更多操作'} /></Dropdown>
        </div></div>
      <Collapse ghost size="small" items={[{ key: 'details', label: '插件信息', children: <Descriptions size="small" column={1} items={[
        { key: 'id', label: 'ID', children: item.manifest.id }, { key: 'api', label: '接口版本', children: item.manifest.apiRange },
        { key: 'hosts', label: '运行环境', children: [item.manifest.hosts.desktop && '桌面', item.manifest.hosts.worker && 'Worker'].filter(Boolean).join(' / ') }
      ]} /> }]} />
    </article>)}</section>
    {installing && <PluginInstaller api={api} close={() => { setInstalling(false); setContinueAdding(false); }} installed={installed} />}
  </>;
}
