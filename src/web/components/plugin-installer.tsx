import { useState } from 'react';
import { Alert, Button, Collapse, Descriptions, Input, Modal, Spin, Tabs, Typography } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PluginInstallation, Status } from '../../contracts/management';
import type { PluginChange } from '../../contracts/plugin-changes';
import type { Api } from '../api';
import { Failure } from './feedback';

type PackageInput = { kind: 'file'; file: File } | { kind: 'url'; url: string };

export function PluginInstaller({ api, close, installed }: { api: Api; close: () => void; installed: (value: PluginInstallation | PluginChange) => Promise<void> }) {
  const client = useQueryClient();
  const [mode, setMode] = useState('file'); const [url, setUrl] = useState(''); const [input, setInput] = useState<PackageInput | null>(null);
  const inspect = useMutation({ mutationFn: (value: PackageInput) => value.kind === 'file' ? api.inspectPlugin(value.file) : api.inspectPluginUrl(value.url) });
  const install = useMutation({ mutationFn: async () => {
    if (!input) throw new Error('请选择插件包');
    return input.kind === 'file' ? api.install(input.file) : api.installUrl(input.url);
  }, onSuccess: installed });
  const value = inspect.data;
  const compatible = value?.compatibility.apiCompatible && value.compatibility.hostCompatible;
  const busy = inspect.isPending || install.isPending;
  function check(next: PackageInput) { setInput(next); install.reset(); inspect.mutate(next); }
  return <Modal title="安装插件" open onCancel={() => { if (!install.isPending) close(); }} closable={!install.isPending} footer={null} width={520} destroyOnHidden>
    <Tabs activeKey={mode} onChange={key => { setMode(key); setInput(null); inspect.reset(); install.reset(); }} items={[
      { key: 'file', label: '本地文件', disabled: busy, children: <div className="file-picker"><UploadOutlined aria-hidden="true" /><label htmlFor="plugin-archive">选择插件 ZIP</label>
        <input id="plugin-archive" type="file" accept=".zip,application/zip" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) check({ kind: 'file', file }); else { setInput(null); inspect.reset(); } }} />
        {client.getQueryData<Status>(['status'])?.host === 'desktop' && <span className="muted-note">随包插件位于桌面包的 plugins 文件夹中。</span>}</div> },
      { key: 'url', label: '下载链接', disabled: busy, children: <div className="field-block"><label htmlFor="plugin-url">插件 ZIP 地址</label><Input id="plugin-url" type="url" value={url} disabled={busy} placeholder="https://example.com/plugin.zip"
        onChange={event => { setUrl(event.target.value); setInput(null); inspect.reset(); install.reset(); }}
        onBlur={() => { if (url.trim() && !input && !busy) check({ kind: 'url', url: url.trim() }); }}
        onPressEnter={() => { if (url.trim() && !busy) check({ kind: 'url', url: url.trim() }); }} /></div> }
    ]} />
    {inspect.isPending && <div className="inline-loading"><Spin size="small" />正在读取插件信息</div>}
    <Failure error={inspect.error} retry={input ? () => check(input) : undefined} />
    {value && !inspect.isPending && <><div className="package-summary"><Typography.Text strong>{value.manifest.name}</Typography.Text><Typography.Text type="secondary">{value.manifest.version}</Typography.Text></div>
      {!compatible && <Alert type="error" showIcon title={!value.compatibility.apiCompatible ? '请先升级 MusicFS，再安装此插件' : '此插件不支持当前运行环境'} />}
      <Collapse ghost size="small" items={[{ key: 'details', label: '技术信息', children: <Descriptions column={1} size="small" items={[
        { key: 'id', label: 'ID', children: value.manifest.id }, { key: 'api', label: '接口版本', children: value.manifest.apiRange },
        { key: 'hosts', label: '运行环境', children: [value.manifest.hosts.desktop && '桌面', value.manifest.hosts.worker && 'Worker'].filter(Boolean).join(' / ') }
      ]} /> }]} />
      <Failure error={install.error} /><Button type="primary" block disabled={!compatible} loading={install.isPending} onClick={() => install.mutate()}>安装</Button>
    </>}
    {!value && !inspect.isPending && mode === 'url' && <Button type="primary" block disabled={!url.trim()} onClick={() => check({ kind: 'url', url: url.trim() })}>继续</Button>}
  </Modal>;
}
