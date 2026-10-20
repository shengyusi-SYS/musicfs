import { Alert, App, Button, Descriptions, Space, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type Api } from '../api';
import { Failure } from './feedback';

export default function DesktopHttps({ api }: { api: Api }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const query = useQuery({ queryKey: ['desktop-https'], queryFn: ({ signal }) => api.desktopHttps(signal),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2 });
  const action = useMutation({ mutationFn: async (kind: 'enable' | 'trust-user' | 'trust-machine' | 'disable') => {
    if (kind === 'enable') return api.enableDesktopHttps();
    if (kind === 'disable') return api.disableDesktopHttps();
    return api.trustDesktopHttps(kind === 'trust-user' ? 'current-user' : 'local-machine');
  }, onSuccess: value => { client.setQueryData(['desktop-https'], value); message.success('本机 HTTPS 设置已更新'); },
  onError: () => { void query.refetch(); } });
  if (query.error instanceof ApiError && query.error.status === 404) return null;
  const value = query.data; const trusted = value?.trust.currentUser || value?.trust.localMachine;
  return <section className="surface"><Typography.Title level={3}>本机 HTTPS WebDAV</Typography.Title>
    <Typography.Paragraph type="secondary">供 Windows 资源管理器原生映射使用。启用后生成此 MusicFS 后台专用的本机证书，再将证书加入 Windows 信任。下方“本机挂载”可直接使用，无需启用此入口。</Typography.Paragraph>
    <Failure error={query.error} retry={() => void query.refetch()} /><Failure error={action.error} />
    {value && <><Typography.Paragraph><Tag color={value.davUrl ? 'success' : 'default'}>{value.davUrl ? 'HTTPS 已启用' : 'HTTPS 未运行'}</Tag>
      {value.davUrl && <Tag color={trusted ? 'success' : 'warning'}>{value.trust.localMachine ? '系统已信任证书' : value.trust.currentUser ? '当前用户已信任证书' : '需要信任证书'}</Tag>}</Typography.Paragraph>
      {value.error && <Alert type="error" showIcon title={value.error} />}
      {value.davUrl && <Descriptions column={1} layout="vertical" items={[
        { key: 'url', label: '本机 HTTPS WebDAV 地址', children: <Typography.Text copyable>{value.davUrl}</Typography.Text> },
        { key: 'expiry', label: '证书到期时间', children: value.certificate ? new Date(value.certificate.expiresAt).toLocaleDateString() : '—' },
        { key: 'fingerprint', label: '证书指纹（SHA-256）', children: <Typography.Text style={{ overflowWrap: 'anywhere' }}>{value.certificate?.fingerprintSha256}</Typography.Text> }
      ]} />}
      <Space wrap>
        {!value.davUrl && <Button type="primary" loading={action.isPending && action.variables === 'enable'} disabled={action.isPending} onClick={() => action.mutate('enable')}>启用本机 HTTPS</Button>}
        {value.davUrl && value.platform === 'win32' && !trusted && <Button type="primary" loading={action.isPending && action.variables === 'trust-user'} disabled={action.isPending} onClick={() => action.mutate('trust-user')}>信任本机证书</Button>}
        {value.davUrl && value.platform === 'win32' && value.trust.currentUser && !value.trust.localMachine && <Button loading={action.isPending && action.variables === 'trust-machine'} disabled={action.isPending} onClick={() => action.mutate('trust-machine')}>安装系统信任</Button>}
        {value.enabled && <Button loading={action.isPending && action.variables === 'disable'} disabled={action.isPending} onClick={() => action.mutate('disable')}>停用 HTTPS</Button>}
        <Button loading={query.isFetching} disabled={action.isPending} onClick={() => void query.refetch()}>刷新状态</Button>
      </Space>
      {value.davUrl && <Typography.Paragraph type="secondary">此地址仅供运行 MusicFS 的这台电脑使用，账号密码与上方读取凭据相同。Windows 原生映射仍不接受证书时，可安装系统信任；Windows 会请求相应权限。停用入口会断开此 HTTPS 连接。</Typography.Paragraph>}
    </>}
  </section>;
}
