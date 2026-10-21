import { useId, useState } from 'react';
import { App, Button, Collapse, Input, Skeleton, Tabs, Typography } from 'antd';
import { CopyOutlined, DesktopOutlined, LinkOutlined, SettingOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { Api } from '../api';
import { Failure } from '../components/feedback';
import { SharedReadCacheDialog } from '../components/cache-settings';
import DesktopHttps from '../components/desktop-https';
import Mounts from './mounts';

export default function Connection({ api, tab, setTab, openSettings }: { api: Api; tab: 'mount' | 'dav'; setTab: (value: 'mount' | 'dav') => void; openSettings(): void }) {
  const status = useQuery({ queryKey: ['status'], queryFn: ({ signal }) => api.status(signal) });
  const desktop = status.data?.host === 'desktop';
  return <Tabs className="connection-tabs" activeKey={desktop ? tab : 'dav'} onChange={key => setTab(key as 'mount' | 'dav')} destroyOnHidden items={[
    ...(desktop ? [{ key: 'mount', label: <><DesktopOutlined aria-hidden="true" /> 挂载到电脑</>, children: <Mounts api={api} /> }] : []),
    { key: 'dav', label: <><LinkOutlined aria-hidden="true" /> WebDAV 播放器</>, children: <DavConnection api={api} desktop={desktop} openSettings={openSettings} /> }
  ]} />;
}

function CopyField({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const id = useId(); const { message } = App.useApp();
  async function copy() {
    try { await navigator.clipboard.writeText(value); message.success('已复制' + label); }
    catch { message.error('复制失败，请手动选择并复制'); }
  }
  return <div className="copy-field"><label htmlFor={id}>{label}</label><div className="copy-field-input">{secret
    ? <Input.Password id={id} value={value} readOnly autoComplete="off" />
    : <Input id={id} value={value} readOnly />}
    <Button icon={<CopyOutlined aria-hidden="true" />} aria-label={'复制' + label} onClick={() => void copy()}>复制</Button></div></div>;
}

function DavConnection({ api, desktop, openSettings }: { api: Api; desktop: boolean; openSettings(): void }) {
  const [cacheOpen, setCacheOpen] = useState(false);
  const connection = useQuery({ queryKey: ['connection'], queryFn: ({ signal }) => api.connection(signal) });
  const prerequisites = useQuery({ queryKey: ['mount-prerequisites'], queryFn: ({ signal }) => api.mountPrerequisites(signal), enabled: desktop });
  const value = connection.data;
  return <><section className="surface connection-card"><div className="section-heading"><Typography.Title level={3}>填入播放器，就能开始听</Typography.Title></div>
    <Failure error={connection.error} retry={() => void connection.refetch()} />{connection.isPending ? <Skeleton active /> : value && <>
      <CopyField label="WebDAV 地址" value={new URL(value.davPath, location.origin).href} />
      <div className="credential-grid"><CopyField label="用户名" value={value.username} /><CopyField label="密码" value={value.password} secret /></div>
    </>}
    {desktop && <Collapse className="connection-options" ghost items={[
      ...(prerequisites.data?.kind === 'winfsp' ? [{ key: 'https', label: 'Windows 资源管理器原生映射', children: <DesktopHttps api={api} /> }] : [])
    ]} />}
  </section>
    {desktop && <div className="secondary-toolbar"><Button type="text" icon={<SettingOutlined aria-hidden="true" />} onClick={openSettings}>局域网访问设置</Button><Button type="text" icon={<SettingOutlined aria-hidden="true" />} onClick={() => setCacheOpen(true)}>WebDAV 读取缓存</Button></div>}
    {cacheOpen && <SharedReadCacheDialog api={api} onClose={() => setCacheOpen(false)} />}
  </>;
}
