import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Descriptions, Divider, Empty, Form, Input, Modal, Space, Table, Tabs, Tag, Typography } from 'antd';
import { PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Api } from '../api';
import { Failure } from '../components/feedback';
import type { PluginChange } from '../../contracts/plugin-changes';

const changeLabels: Record<PluginChange['status'], string> = { queued: '等待处理', preparing: '准备升级', uploading: '正在上传代码', deploying: '正在发布', verifying: '核对发布结果', migrating: '准备实例数据', completed: '已完成', failed: '未完成' };

export default function Plugins({ api }: { api: Api }) {
  const client = useQueryClient(); const { modal, message } = App.useApp();
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: ({ signal }) => api.plugins(signal) });
  const [operationId, setOperationId] = useState(() => sessionStorage.getItem('musicfs.pluginChange'));
  const [changeError, setChangeError] = useState(''); const handled = useRef<string | null>(null);
  const change = useQuery({ queryKey: ['plugin-change', operationId], enabled: !!operationId,
    queryFn: ({ signal }) => api.pluginChange(operationId!, signal),
    refetchInterval: query => query.state.data?.status === 'completed' || query.state.data?.status === 'failed' ? false : 1500 });
  async function invalidate() {
    await Promise.all(['plugins', 'instances', 'configuration', 'authentication', 'refresh-current', 'roots', 'library', 'directory-status'].map(key => client.invalidateQueries({ queryKey: [key] })));
  }
  function follow(value: PluginChange) { setChangeError(''); sessionStorage.setItem('musicfs.pluginChange', value.operationId); setOperationId(value.operationId); }
  useEffect(() => {
    const value = change.data;
    if (!value || value.status !== 'completed' && value.status !== 'failed' || handled.current === value.operationId) return;
    handled.current = value.operationId;
    sessionStorage.removeItem('musicfs.pluginChange'); setOperationId(null);
    if (value.status === 'failed') setChangeError(value.error?.message ?? '插件变更未完成，原安装仍然保留。');
    else { void invalidate(); message.success(value.kind === 'remove' ? '插件已移除，实例与目录引用已保留' : `已安装 ${value.installation?.manifest.name ?? value.pluginId}`); }
  }, [change.data]);
  const [installing, setInstalling] = useState(false); const [mode, setMode] = useState<'file' | 'url'>('file');
  const [file, setFile] = useState<File | null>(null); const [url, setUrl] = useState('');
  const inspect = useMutation({ mutationFn: async () => {
    if (mode === 'file') { if (!file) throw new Error('请选择预构建插件 ZIP'); return api.inspectPlugin(file); }
    if (!url.trim()) throw new Error('请输入插件发布地址'); return api.inspectPluginUrl(url.trim());
  } });
  const install = useMutation({ mutationFn: async () => {
    if (!inspect.data?.compatibility.apiCompatible || !inspect.data.compatibility.hostCompatible) throw new Error('请先检查插件，确认与当前宿主兼容。');
    if (mode === 'file') { if (!file) throw new Error('请选择预构建插件 ZIP'); return api.install(file); }
    if (!url.trim()) throw new Error('请输入插件发布地址'); return api.installUrl(url.trim());
  }, onSuccess: async installed => {
    setInstalling(false); setFile(null); setUrl(''); inspect.reset();
    if ('operationId' in installed) { follow(installed); return; }
    await invalidate(); message.success(`已安装 ${installed.manifest.name} ${installed.manifest.version}`);
  } });
  const remove = useMutation({ mutationFn: (id: string) => api.removePlugin(id), onSuccess: async value => {
    if (value) { follow(value); return; }
    await invalidate(); message.success('插件已移除，实例与目录引用已保留');
  } });
  const busy = inspect.isPending || install.isPending;
  const inspection = inspect.data;
  const compatible = inspection?.compatibility.apiCompatible && inspection.compatibility.hostCompatible;
  const previous = plugins.data?.find(value => value.manifest.id === inspection?.manifest.id && value.status === 'active');
  function clearInspection() { inspect.reset(); install.reset(); }
  function openInstall() { if (busy || operationId) return; clearInspection(); setFile(null); setUrl(''); setChangeError(''); setInstalling(true); }
  const active = plugins.data?.filter(value => value.status === 'active').length ?? 0;
  return <>
    <div className="page-actions"><span>{active} 个已启用插件</span><Button type="primary" disabled={!!operationId || busy} icon={<PlusOutlined />} onClick={openInstall}>安装插件</Button></div>
    {operationId && <Alert type="info" showIcon title={change.data ? changeLabels[change.data.status] : '正在查询插件变更'} description="插件变更由后台继续处理，页面重新打开后会恢复查询。" />}
    {changeError && <Alert type="error" showIcon title="插件变更未完成" description={changeError} closable onClose={() => setChangeError('')} />}
    <Failure error={change.error} retry={() => void change.refetch()} />
    <Failure error={plugins.error} retry={() => void plugins.refetch()} /><Failure error={remove.error} />
    <section className="surface table-surface"><Table rowKey={item => item.manifest.id} loading={plugins.isPending} dataSource={plugins.data} pagination={false}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未安装来源插件"><Button disabled={!!operationId || busy} onClick={openInstall}>安装第一个插件</Button></Empty> }}
      columns={[
        { title: '插件', key: 'name', render: (_, item) => <div><Typography.Text strong>{item.manifest.name}</Typography.Text><div className="secondary-id">{item.manifest.id}</div></div> },
        { title: '版本', key: 'version', render: (_, item) => <div><span className="mono">{item.manifest.version}</span><div className="secondary-id">API {item.manifest.apiRange}</div></div> },
        { title: '支持宿主', key: 'hosts', responsive: ['md'], render: (_, item) => <Space>{item.manifest.hosts.desktop && <Tag>桌面</Tag>}{item.manifest.hosts.worker && <Tag>Worker</Tag>}</Space> },
        { title: '状态', key: 'status', render: (_, item) => <Tag color={item.status === 'active' ? 'success' : 'default'}>{item.status === 'active' ? '可用' : '已移除'}</Tag> },
        { title: '操作', key: 'actions', render: (_, item) => <Space><Button type="link" disabled={!!operationId || busy} onClick={openInstall}>安装 / 更新</Button>{item.status === 'active' && <Button type="text" danger disabled={remove.isPending || !!operationId || busy} onClick={() => modal.confirm({
          title: `移除 ${item.manifest.name}？`, content: '此插件的读取会停止。实例配置、授权和目录引用将保留，重装兼容版本后可恢复。', okText: '移除插件', cancelText: '保留',
          onOk: () => remove.mutateAsync(item.manifest.id)
        })}>移除</Button>}</Space> }
      ]} />
    </section><p className="page-footnote">插件负责来源适配。同一插件可创建多个独立实例。</p>
    <Modal title="安装来源插件" open={installing} onCancel={() => { if (!busy) { setInstalling(false); clearInspection(); } }} footer={null} destroyOnHidden mask={{ closable: !busy }} closable={!busy}>
      <Typography.Paragraph type="secondary">选择作者发布的预构建 ZIP，或填写直接下载地址。先检查插件信息与兼容性，再确认安装。</Typography.Paragraph>
      <Tabs activeKey={mode} onChange={value => { if (!busy) { setMode(value === 'url' ? 'url' : 'file'); clearInspection(); } }} items={[
        { key: 'file', label: '上传插件包', disabled: busy, children: <div className="file-picker"><UploadOutlined /><label htmlFor="plugin-archive">选择插件 ZIP</label><input id="plugin-archive" type="file" accept=".zip,application/zip" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); clearInspection(); }} /></div> },
        { key: 'url', label: '发布地址', disabled: busy, children: <Form layout="vertical"><Form.Item label="插件 ZIP 下载地址"><Input type="url" placeholder="https://example.com/releases/source.zip" value={url} onChange={event => { setUrl(event.target.value); clearInspection(); }} disabled={busy} /></Form.Item></Form> }
      ]} />
      <Failure error={inspect.error} />
      <Button type={inspection ? 'default' : 'primary'} block loading={inspect.isPending} disabled={install.isPending || (mode === 'file' ? !file : !url.trim())}
        onClick={() => { install.reset(); inspect.mutate(); }}>{inspection ? '重新检查插件' : '检查插件'}</Button>
      {inspection && !inspect.isPending && <>
        <Divider />
        <Descriptions column={1} size="small" title={inspection.manifest.name} styles={{ content: { overflowWrap: 'anywhere' } }} items={[
          { key: 'id', label: '插件 ID', children: <span className="mono">{inspection.manifest.id}</span> },
          { key: 'version', label: '插件版本', children: <Space wrap><span className="mono">{inspection.manifest.version}</span>{previous && <Typography.Text type="secondary">当前 {previous.manifest.version}</Typography.Text>}</Space> },
          { key: 'api', label: '插件 API', children: <Space wrap><span className="mono">{inspection.manifest.apiRange}</span><Typography.Text type="secondary">当前 {inspection.compatibility.apiVersion}</Typography.Text><Tag color={inspection.compatibility.apiCompatible ? 'success' : 'error'}>{inspection.compatibility.apiCompatible ? 'API 兼容' : 'API 不兼容'}</Tag></Space> },
          { key: 'hosts', label: '支持宿主', children: <Space wrap>{inspection.manifest.hosts.desktop && <Tag>桌面</Tag>}{inspection.manifest.hosts.worker && <Tag>Worker</Tag>}<Typography.Text type="secondary">当前 {inspection.compatibility.host === 'desktop' ? '桌面' : 'Worker'}</Typography.Text><Tag color={inspection.compatibility.hostCompatible ? 'success' : 'error'}>{inspection.compatibility.hostCompatible ? '宿主兼容' : '宿主不兼容'}</Tag></Space> }
        ]} />
        <Alert style={{ marginBlock: 16 }} showIcon type={compatible ? 'success' : 'error'} title={compatible ? '与当前宿主兼容，可以安装' : '此插件与当前宿主不兼容'} />
        <Failure error={install.error} />
        {compatible && <Button type="primary" block loading={install.isPending} disabled={inspect.isPending || !!operationId} onClick={() => install.mutate()}>{previous ? '更新插件' : '安装插件'}</Button>}
        <Typography.Paragraph type="secondary" className="page-footnote">检查不会安装插件。{mode === 'url' ? '安装时会重新下载并校验插件包。' : '安装时会再次校验插件包。'}</Typography.Paragraph>
      </>}
    </Modal>
  </>;
}
