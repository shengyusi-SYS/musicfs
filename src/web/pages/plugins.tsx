import { useState } from 'react';
import { App, Button, Empty, Form, Input, Modal, Space, Table, Tabs, Tag, Typography } from 'antd';
import { PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Api } from '../api';
import { Failure } from '../components/feedback';

export default function Plugins({ api }: { api: Api }) {
  const client = useQueryClient(); const { modal, message } = App.useApp();
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: ({ signal }) => api.plugins(signal) });
  const [installing, setInstalling] = useState(false); const [mode, setMode] = useState('file');
  const [file, setFile] = useState<File | null>(null); const [url, setUrl] = useState('');
  const install = useMutation({ mutationFn: async () => {
    if (mode === 'file') { if (!file) throw new Error('请选择预构建插件 ZIP'); return api.install(file); }
    if (!url.trim()) throw new Error('请输入插件发布地址'); return api.installUrl(url.trim());
  }, onSuccess: async installed => {
    await client.invalidateQueries({ queryKey: ['plugins'] }); await client.invalidateQueries({ queryKey: ['configuration'] });
    await client.invalidateQueries({ queryKey: ['roots'] }); await client.invalidateQueries({ queryKey: ['library'] });
    await client.invalidateQueries({ queryKey: ['directory-status'] });
    message.success(`已安装 ${installed.manifest.name} ${installed.manifest.version}`); setInstalling(false); setFile(null); setUrl('');
  } });
  const remove = useMutation({ mutationFn: (id: string) => api.removePlugin(id), onSuccess: async () => {
    await client.invalidateQueries({ queryKey: ['plugins'] }); await client.invalidateQueries({ queryKey: ['roots'] });
    await client.invalidateQueries({ queryKey: ['library'] }); message.success('插件已移除，实例与目录引用已保留');
    await client.invalidateQueries({ queryKey: ['directory-status'] });
  } });
  const active = plugins.data?.filter(value => value.status === 'active').length ?? 0;
  return <>
    <div className="page-actions"><span>{active} 个已启用插件</span><Button type="primary" icon={<PlusOutlined />} onClick={() => { install.reset(); setInstalling(true); }}>安装插件</Button></div>
    <Failure error={plugins.error} retry={() => void plugins.refetch()} /><Failure error={remove.error} />
    <section className="surface table-surface"><Table rowKey={item => item.manifest.id} loading={plugins.isPending} dataSource={plugins.data} pagination={false}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未安装来源插件"><Button onClick={() => setInstalling(true)}>安装第一个插件</Button></Empty> }}
      columns={[
        { title: '插件', key: 'name', render: (_, item) => <div><Typography.Text strong>{item.manifest.name}</Typography.Text><div className="secondary-id">{item.manifest.id}</div></div> },
        { title: '版本', key: 'version', render: (_, item) => <span className="mono">{item.manifest.version}</span> },
        { title: '支持宿主', key: 'hosts', responsive: ['md'], render: (_, item) => <Space>{item.manifest.hosts.desktop && <Tag>桌面</Tag>}{item.manifest.hosts.worker && <Tag>Worker</Tag>}</Space> },
        { title: '状态', key: 'status', render: (_, item) => <Tag color={item.status === 'active' ? 'success' : 'default'}>{item.status === 'active' ? '可用' : '已移除'}</Tag> },
        { title: '操作', key: 'actions', render: (_, item) => <Space><Button type="link" onClick={() => { install.reset(); setInstalling(true); }}>安装 / 更新</Button>{item.status === 'active' && <Button type="text" danger disabled={remove.isPending} onClick={() => modal.confirm({
          title: `移除 ${item.manifest.name}？`, content: '此插件的读取会停止。实例配置、授权和目录引用将保留，重装兼容版本后可恢复。', okText: '移除插件', cancelText: '保留',
          onOk: () => remove.mutateAsync(item.manifest.id)
        })}>移除</Button>}</Space> }
      ]} />
    </section><p className="page-footnote">插件负责来源适配。同一插件可创建多个独立实例。</p>
    <Modal title="安装来源插件" open={installing} onCancel={() => { if (!install.isPending) setInstalling(false); }} footer={null} destroyOnHidden mask={{ closable: !install.isPending }} closable={!install.isPending}>
      <Typography.Paragraph type="secondary">选择作者发布的预构建 ZIP，或填写直接下载地址。已有插件会先检查兼容性，再切换版本。</Typography.Paragraph>
      <Tabs activeKey={mode} onChange={value => { setMode(value); install.reset(); }} items={[
        { key: 'file', label: '上传插件包', children: <div className="file-picker"><UploadOutlined /><label htmlFor="plugin-archive">选择插件 ZIP</label><input id="plugin-archive" type="file" accept=".zip,application/zip" disabled={install.isPending} onChange={event => setFile(event.target.files?.[0] ?? null)} /></div> },
        { key: 'url', label: '发布地址', children: <Form layout="vertical"><Form.Item label="插件 ZIP 下载地址"><Input type="url" placeholder="https://example.com/releases/source.zip" value={url} onChange={event => setUrl(event.target.value)} disabled={install.isPending} /></Form.Item></Form> }
      ]} />
      <Failure error={install.error} /><Button type="primary" block loading={install.isPending} onClick={() => install.mutate()}>安装并检查兼容性</Button>
    </Modal>
  </>;
}
