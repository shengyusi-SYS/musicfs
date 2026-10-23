import { useState } from 'react';
import { Button, Collapse, Divider, Skeleton, Tabs, Typography } from 'antd';
import { DesktopOutlined, LinkOutlined, SettingOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { Api } from '../api';
import { Failure } from '../components/feedback';
import { SharedReadCacheDialog } from '../components/cache-settings';
import DesktopHttps from '../components/desktop-https';
import { DavConnectionDetails } from '../components/dav-connection';
import DesktopNetwork from '../components/desktop-network';
import Mounts from './mounts';

export default function Connection({ api, tab, setTab }: { api: Api; tab: 'mount' | 'dav'; setTab: (value: 'mount' | 'dav') => void }) {
  const status = useQuery({ queryKey: ['status'], queryFn: ({ signal }) => api.status(signal) });
  const desktop = status.data?.host === 'desktop';
  return <Tabs className="connection-tabs" activeKey={desktop ? tab : 'dav'} onChange={key => setTab(key as 'mount' | 'dav')} destroyOnHidden items={[
    ...(desktop ? [{ key: 'mount', label: <><DesktopOutlined aria-hidden="true" /> 挂载到电脑</>, children: <Mounts api={api} /> }] : []),
    { key: 'dav', label: <><LinkOutlined aria-hidden="true" /> WebDAV 播放器</>, children: <DavConnection api={api} desktop={desktop} /> }
  ]} />;
}

function DavConnection({ api, desktop }: { api: Api; desktop: boolean }) {
  const [cacheOpen, setCacheOpen] = useState(false);
  const connection = useQuery({ queryKey: ['connection'], queryFn: ({ signal }) => api.connection(signal) });
  const prerequisites = useQuery({ queryKey: ['mount-prerequisites'], queryFn: ({ signal }) => api.mountPrerequisites(signal), enabled: desktop });
  const value = connection.data;
  return <><section className="surface connection-card"><div className="section-heading"><Typography.Title level={3}>填入播放器，就能开始听</Typography.Title></div>
    {desktop && <><DesktopNetwork api={api} scope="dav" /><Divider /></>}
    <Failure error={connection.error} retry={() => void connection.refetch()} />{connection.isPending ? <Skeleton active /> : value && <>
      <DavConnectionDetails api={api} value={value} desktop={desktop} />
    </>}
    {desktop && <Collapse className="connection-options" ghost items={[
      ...(prerequisites.data?.kind === 'winfsp' ? [{ key: 'https', label: 'Windows 资源管理器原生映射', children: <DesktopHttps api={api} /> }] : [])
    ]} />}
  </section>
    {desktop && <div className="secondary-toolbar"><Button type="text" icon={<SettingOutlined aria-hidden="true" />} onClick={() => setCacheOpen(true)}>WebDAV 读取缓存</Button></div>}
    {cacheOpen && <SharedReadCacheDialog api={api} onClose={() => setCacheOpen(false)} />}
  </>;
}
