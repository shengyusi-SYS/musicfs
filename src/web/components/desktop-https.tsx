import { Alert, App, Button, Descriptions, Space, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type Api } from '../api';
import { Failure } from './feedback';
import { WINDOWS_WEBDAV_FILE_LIMIT } from '../../contracts/desktop-https';

const fileLimit = (bytes: number | null) => bytes === null ? '未检测' : `${bytes.toLocaleString()} 字节（${(bytes / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB）`;

export default function DesktopHttps({ api }: { api: Api }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const query = useQuery({ queryKey: ['desktop-https'], queryFn: ({ signal }) => api.desktopHttps(signal),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2 });
  const action = useMutation({ mutationFn: async (kind: 'enable' | 'trust' | 'disable' | 'restore') => {
    if (kind === 'enable') return api.enableDesktopHttps();
    if (kind === 'disable') return api.disableDesktopHttps();
    if (kind === 'restore') return api.restoreWebDavFileSizeLimit();
    return api.trustDesktopHttps();
  }, onSuccess: (value, kind) => { client.setQueryData(['desktop-https'], value);
    message.success(kind === 'restore' ? '原文件上限已恢复' : kind === 'trust' ? 'Windows 连接设置已更新' : '本机 HTTPS 设置已更新'); },
  onError: () => { void query.refetch(); } });
  if (query.error instanceof ApiError && query.error.status === 404) return null;
  if (query.data && query.data.platform !== 'win32') return null;
  const value = query.data; const ready = value?.trusted && value.webClient === 'running';
  const largeFiles = value?.fileSizeLimitBytes === WINDOWS_WEBDAV_FILE_LIMIT;
  return <section className="surface"><Typography.Title level={3}>本机 HTTPS WebDAV</Typography.Title>
    <Typography.Paragraph type="secondary">供 Windows 资源管理器原生映射使用。启用 HTTPS 后，App 可一次完成证书信任、启动现有 WebClient，并将单文件上限提高到 4GiB−1。Windows 会请求系统权限；下方“本机挂载”无需这些原生客户端设置。</Typography.Paragraph>
    <Failure error={query.error} retry={() => void query.refetch()} /><Failure error={action.error} />
    {value && <><Typography.Paragraph><Tag color={value.davUrl ? 'success' : 'default'}>{value.davUrl ? 'HTTPS 已启用' : 'HTTPS 未运行'}</Tag>
      {value.davUrl && value.platform === 'win32' && <Tag color={ready ? 'success' : 'warning'}>{ready ? 'Windows 连接设置已就绪' : '需要完成 Windows 连接设置'}</Tag>}</Typography.Paragraph>
      {value.error && <Alert type="error" showIcon title={value.error} />}
      <Descriptions column={1} layout="vertical" items={[
        { key: 'file-limit', label: 'Windows 原生映射单文件上限', children: fileLimit(value.fileSizeLimitBytes) }
      ]} />
      {value.davUrl && <Descriptions column={1} layout="vertical" items={[
        { key: 'url', label: '本机 HTTPS WebDAV 地址', children: <Typography.Text copyable>{value.davUrl}</Typography.Text> },
        { key: 'expiry', label: '证书到期时间', children: value.certificate ? new Date(value.certificate.expiresAt).toLocaleDateString() : '—' },
        { key: 'fingerprint', label: '证书指纹（SHA-256）', children: <Typography.Text style={{ overflowWrap: 'anywhere' }}>{value.certificate?.fingerprintSha256}</Typography.Text> }
      ]} />}
      <Space wrap>
        {!value.davUrl && <Button type="primary" loading={action.isPending && action.variables === 'enable'} disabled={action.isPending} onClick={() => action.mutate('enable')}>启用本机 HTTPS</Button>}
        {value.davUrl && (!ready || !largeFiles) && <Button type="primary" loading={action.isPending && action.variables === 'trust'} disabled={action.isPending} onClick={() => action.mutate('trust')}>
          {value.webClient === 'running' && !largeFiles ? '应用设置并重连' : '完成 Windows 连接设置'}
        </Button>}
        {value.canRestoreFileSizeLimit && <Button loading={action.isPending && action.variables === 'restore'} disabled={action.isPending} onClick={() => action.mutate('restore')}>恢复原文件上限</Button>}
        {value.enabled && <Button loading={action.isPending && action.variables === 'disable'} disabled={action.isPending} onClick={() => action.mutate('disable')}>停用 HTTPS</Button>}
        <Button loading={query.isFetching} disabled={action.isPending} onClick={() => void query.refetch()}>刷新状态</Button>
      </Space>
      <Typography.Paragraph type="secondary">文件上限影响本机所有 Windows 原生 WebDAV 连接。修改或恢复上限需要重启正在运行的 WebClient，会短暂中断这些连接；请在方便重连时应用。App 退出后保持设置。</Typography.Paragraph>
      {value.canRestoreFileSizeLimit && <Typography.Paragraph type="secondary">可恢复到原上限：{fileLimit(value.originalFileSizeLimitBytes)}。恢复只调整文件上限，保留 HTTPS 和证书信任。</Typography.Paragraph>}
      {value.davUrl && <Typography.Paragraph type="secondary">此地址仅供运行 MusicFS 的这台电脑使用，账号密码与上方读取凭据相同。停用入口会断开此 HTTPS 连接；重新启用会复用同一证书。</Typography.Paragraph>}
    </>}
  </section>;
}
