import { t } from '../i18n';
import { useEffect, useId, useState } from 'react';
import { Button, Modal, QRCode, Select, Skeleton, Space, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { Api } from '../api';
import { Failure } from './feedback';

export function PhoneAccess({ api, onClose, openSettings }: { api: Api; onClose(): void; openSettings(): void }) {
  const id = useId();
  const network = useQuery({ queryKey: ['desktop-network'], queryFn: ({ signal }) => api.desktopNetwork(signal), refetchOnMount: 'always' });
  const addresses = !network.isFetching && !network.isError && network.data?.active.managementAccess === 'lan' ? network.data.managementUrls.filter(value => new URL(value).hostname !== '127.0.0.1') : [];
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
  return <Modal title={t("手机访问")} open onCancel={onClose} footer={null} destroyOnHidden>
    <Failure error={network.error} retry={() => void network.refetch()} />
    {network.isPending || network.isFetching ? <Skeleton active /> : !network.isError && network.data && !address ? <div className="phone-access-empty"><Typography.Paragraph>{network.data.active.managementAccess === 'local' ? t("先在「设置 → 管理页面访问」允许局域网设备访问。") : t("暂未找到局域网地址，请连接网络后重试。")}</Typography.Paragraph>
      <Space><Button type="primary" onClick={openSettings}>{t("打开设置")}</Button><Button onClick={() => void network.refetch()}>{t("重新检测")}</Button></Space>
    </div> : address && <div className="phone-access-content">
      {addresses.length > 1 && <Select aria-label={t("手机访问地址")} value={address} options={addresses.map(value => ({ label: value, value }))} onChange={select} />}
      <Failure error={entry.error} retry={() => void entry.refetch()} />
      {url ? <QRCode value={url} size={224} status={entry.isFetching ? 'loading' : expired ? 'expired' : 'active'} onRefresh={() => void entry.refetch()} /> : entry.isPending && <Skeleton.Node active />}
      <Typography.Text type="secondary">{t("手机连接同一网络后扫码")}</Typography.Text>
      <Typography.Text copyable={{ text: address }}>{address}</Typography.Text>
      <Button loading={entry.isFetching} onClick={() => void entry.refetch()}>{t("更新二维码")}</Button>
    </div>}
  </Modal>;
}
