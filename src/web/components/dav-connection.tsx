import { useId, useState } from 'react';
import { App, Button, Form, Input, Modal, QRCode, Select, Skeleton, Space, Typography } from 'antd';
import { CopyOutlined, EditOutlined, QrcodeOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from 'react-error-boundary';
import type { Api } from '../api';
import type { Connection } from '../../contracts/management';
import type { DavCredentials } from '../../contracts/dav-access';
import { davImportUrl } from '../dav-link';
import { Failure } from './feedback';

function CopyField({ label, value, options, onChange }: { label: string; value: string; options?: string[]; onChange?: (value: string) => void }) {
  const id = useId(); const { message } = App.useApp();
  async function copy() {
    try { await navigator.clipboard.writeText(value); message.success('已复制' + label); }
    catch { message.error('复制失败，请手动选择并复制'); }
  }
  return <div className="copy-field"><label htmlFor={id}>{label}</label><div className="copy-field-input">
    {options && options.length > 1 && onChange ? <Select id={id} className="copy-field-select" value={value} options={options.map(address => ({ value: address, label: address }))} onChange={onChange} /> : <Input id={id} value={value} readOnly autoComplete="off" />}
    <Button icon={<CopyOutlined aria-hidden="true" />} aria-label={'复制' + label} onClick={() => void copy()}>复制</Button></div></div>;
}

export function DavConnectionDetails({ api, value, desktop }: { api: Api; value: Connection; desktop: boolean }) {
  const [editing, setEditing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const network = useQuery({ queryKey: ['desktop-network'], queryFn: ({ signal }) => api.desktopNetwork(signal), enabled: desktop });
  const localOnly = desktop && network.data?.active.davAccess === 'local';
  const addresses = desktop ? network.data?.davUrls ?? [] : [new URL(value.davPath + '/', location.origin).href];
  const [selected, select] = useState('');
  const address = addresses.includes(selected) ? selected : addresses.find(address => !['localhost', '127.0.0.1', '[::1]'].includes(new URL(address).hostname)) ?? addresses[0] ?? '';
  return <>
    <Failure error={network.error} retry={() => void network.refetch()} />
    {desktop && network.isPending ? <Skeleton.Input active block /> : <CopyField label={localOnly ? '本机 WebDAV 地址' : 'WebDAV 地址'} value={address} options={addresses} onChange={select} />}
    <div className="credential-grid"><CopyField label="用户名" value={value.username} /><CopyField label="密码" value={value.password} /></div>
    <Space wrap className="dav-actions"><Button type="primary" icon={<QrcodeOutlined aria-hidden="true" />} onClick={() => setScanning(true)}>扫码导入</Button>
      <Button icon={<EditOutlined aria-hidden="true" />} onClick={() => setEditing(true)}>修改账号密码</Button></Space>
    {editing && <DavCredentialsDialog api={api} value={value} close={() => setEditing(false)} />}
    {scanning && <DavImportDialog api={api} value={value} desktop={desktop} close={() => setScanning(false)} />}
  </>;
}

function DavCredentialsDialog({ api, value, close }: { api: Api; value: Connection; close(): void }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const save = useMutation({ mutationFn: (credentials: DavCredentials) => api.saveConnection(credentials),
    onSuccess: next => { client.setQueryData(['connection'], next); message.success('WebDAV 账号密码已保存'); close(); } });
  return <Modal title="WebDAV 账号密码" open onCancel={close} footer={null} destroyOnHidden>
    <Typography.Paragraph type="secondary">保存后，已有播放器需更新连接信息。</Typography.Paragraph>
    <Form<DavCredentials> layout="vertical" initialValues={{ username: value.username, password: value.password }} onFinish={credentials => save.mutate({ ...credentials, username: credentials.username.trim() })} disabled={save.isPending}>
      <Form.Item label="用户名" name="username" rules={[{ required: true, whitespace: true, message: '请输入用户名' }, { max: 128 }, { pattern: /^[^:\u0000-\u001f\u007f]+$/, message: '用户名不能包含冒号或控制字符' }]}><Input autoComplete="off" autoFocus maxLength={128} /></Form.Item>
      <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }, { max: 256 }, { pattern: /^[^\u0000-\u001f\u007f]+$/, message: '密码不能包含换行等控制字符' }]}><Input autoComplete="off" maxLength={256} /></Form.Item>
      <Failure error={save.error} /><Space><Button type="primary" htmlType="submit" loading={save.isPending}>保存</Button><Button onClick={close}>取消</Button></Space>
    </Form>
  </Modal>;
}

function DavImportDialog({ api, value, desktop, close }: { api: Api; value: Connection; desktop: boolean; close(): void }) {
  const network = useQuery({ queryKey: ['desktop-network'], queryFn: ({ signal }) => api.desktopNetwork(signal), enabled: desktop });
  const current = new URL(value.davPath + '/', location.origin).href;
  const addresses = desktop ? network.data?.active.davAccess === 'lan'
    ? network.data.davUrls.filter(address => !['localhost', '127.0.0.1', '[::1]'].includes(new URL(address).hostname)) : [] : [current];
  const [selected, select] = useState('');
  const address = addresses.includes(selected) ? selected : addresses[0];
  const url = address ? davImportUrl(address, value) : '';
  return <Modal title="扫码导入 WebDAV" open onCancel={close} footer={null} destroyOnHidden>
    <Failure error={network.error} retry={() => void network.refetch()} />
    {desktop && network.isPending ? <Skeleton active /> : address ? <>
      {addresses.length > 1 && <Select className="dav-address-select" aria-label="WebDAV 扫码地址" value={address} options={addresses.map(item => ({ value: item, label: item }))} onChange={select} />}
      <div className="dav-qr"><ErrorBoundary fallback={<Typography.Text>连接信息较长，请手动填入播放器。</Typography.Text>}><QRCode value={url} size={240} marginSize={4} /></ErrorBoundary></div>
      <Typography.Paragraph type="secondary">用支持连接地址导入的播放器扫码，二维码包含用户名和密码。</Typography.Paragraph>
      <CopyField label="含账号密码的连接地址" value={url} />
    </> : !network.isError && <>
      <Typography.Paragraph>{network.data?.active.davAccess === 'local' ? '先在当前页面将访问设备设为「局域网设备」。' : '暂未找到局域网地址，请连接网络后重试。'}</Typography.Paragraph>
      <Space><Button type="primary" onClick={close}>返回连接设置</Button><Button onClick={() => void network.refetch()}>重新检测</Button></Space>
    </>}
  </Modal>;
}
