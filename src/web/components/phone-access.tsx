import { useEffect, useId, useState } from 'react';
import { Button, Modal, QRCode, Select, Skeleton, Space, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { Api } from '../api';
import { Failure } from './feedback';

export function PhoneAccess({ api, onClose, openSettings }: { api: Api; onClose(): void; openSettings(): void }) {
  const id = useId();
  const network = useQuery({ queryKey: ['desktop-network'], queryFn: ({ signal }) => api.desktopNetwork(signal) });
  const addresses = network.data?.active.managementAccess === 'lan' ? network.data.managementUrls.filter(value => new URL(value).hostname !== '127.0.0.1') : [];
  const [selected, select] = useState('');
  const address = addresses.includes(selected) ? selected : addresses[0];
  const entry = useQuery({ queryKey: ['phone-ticket', id], queryFn: () => api.accessTicket(), enabled: Boolean(address), staleTime: Infinity, gcTime: 0, retry: false });
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!entry.data) return;
    const remaining = Date.parse(entry.data.expiresAt) - Date.now();
    setExpired(remaining <= 0);
    const timer = setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [entry.data]);
  const url = address && entry.data ? new URL('/#' + new URLSearchParams({ ticket: entry.data.ticket }), address).href : '';
  return <Modal title="手机访问" open onCancel={onClose} footer={null} destroyOnHidden>
    <Failure error={network.error} retry={() => void network.refetch()} />
    {network.isPending ? <Skeleton active /> : network.data && !address ? <div className="phone-access-empty"><Typography.Paragraph>{network.data.active.managementAccess === 'local' ? '先在设置中允许管理页面的局域网访问。' : network.data.restartRequired ? '局域网设置已保存，重新启动 MusicFS 后即可扫码。' : '暂未找到局域网地址，请连接网络后重试。'}</Typography.Paragraph>
      <Space><Button type="primary" onClick={openSettings}>打开设置</Button><Button onClick={() => void network.refetch()}>重新检测</Button></Space>
    </div> : address && <div className="phone-access-content">
      {addresses.length > 1 && <Select aria-label="手机访问地址" value={address} options={addresses.map(value => ({ label: value, value }))} onChange={select} />}
      <Failure error={entry.error} retry={() => void entry.refetch()} />
      {url ? <QRCode value={url} size={224} status={entry.isFetching ? 'loading' : expired ? 'expired' : 'active'} onRefresh={() => void entry.refetch()} /> : entry.isPending && <Skeleton.Node active />}
      <Typography.Text type="secondary">手机连接同一网络后扫码</Typography.Text>
      <Typography.Text copyable={{ text: address }}>{address}</Typography.Text>
      <Button loading={entry.isFetching} onClick={() => void entry.refetch()}>更新二维码</Button>
    </div>}
  </Modal>;
}
