import { t, currentLanguage } from '../i18n';
import { Alert, App, Button, Collapse, Descriptions, Space, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type Api } from '../api';
import { Failure } from './feedback';
import { WINDOWS_WEBDAV_FILE_LIMIT } from '../../contracts/desktop-https';

const fileLimit = (bytes: number | null) => bytes === null ? t("未检测") : t("{{value0}} 字节（{{value1}} MiB）", { value0: bytes.toLocaleString(currentLanguage()), value1: (bytes / 1024 ** 2).toLocaleString(currentLanguage(), { maximumFractionDigits: 1 }) });

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
    message.success(kind === 'restore' ? t("原文件上限已恢复") : kind === 'trust' ? t("Windows 连接设置已更新") : t("本机 HTTPS 设置已更新")); },
  onError: () => { void query.refetch(); } });
  if (query.error instanceof ApiError && query.error.status === 404) return null;
  if (query.data && query.data.platform !== 'win32') return null;
  const value = query.data; const ready = value?.trusted && value.webClient === 'running';
  const largeFiles = value?.fileSizeLimitBytes === WINDOWS_WEBDAV_FILE_LIMIT;
  return <div className="settings-content">
    <Typography.Paragraph type="secondary">{t("使用 HTTPS 地址映射网络驱动器，账号密码与上方相同。")}</Typography.Paragraph>
    <Failure error={query.error} retry={() => void query.refetch()} /><Failure error={action.error} />
    {value && <><Typography.Paragraph><Tag color={value.davUrl ? 'success' : 'default'}>{value.davUrl ? t("HTTPS 已启用") : t("HTTPS 未运行")}</Tag>
      {value.davUrl && value.platform === 'win32' && <Tag color={ready ? 'success' : 'warning'}>{ready ? t("Windows 连接设置已就绪") : t("需要完成 Windows 连接设置")}</Tag>}</Typography.Paragraph>
      {value.error && <Alert type="error" showIcon title={value.error} />}
      <Descriptions column={1} layout="vertical" items={[
        { key: 'file-limit', label: t("Windows 原生映射单文件上限"), children: fileLimit(value.fileSizeLimitBytes) }
      ]} />
      {value.davUrl && <Descriptions column={1} layout="vertical" items={[
        { key: 'url', label: t("本机 HTTPS WebDAV 地址"), children: <Typography.Text copyable>{value.davUrl}</Typography.Text> },
      ]} />}
      <Space wrap>
        {!value.davUrl && <Button type="primary" loading={action.isPending && action.variables === 'enable'} disabled={action.isPending} onClick={() => action.mutate('enable')}>{t("启用本机 HTTPS")}</Button>}
        {value.davUrl && (!ready || !largeFiles) && <Button type="primary" loading={action.isPending && action.variables === 'trust'} disabled={action.isPending} onClick={() => action.mutate('trust')}>
          {value.webClient === 'running' && !largeFiles ? t("应用设置并重连") : t("完成 Windows 连接设置")}
        </Button>}
        {value.canRestoreFileSizeLimit && <Button loading={action.isPending && action.variables === 'restore'} disabled={action.isPending} onClick={() => action.mutate('restore')}>{t("恢复原文件上限")}</Button>}
        {value.enabled && <Button loading={action.isPending && action.variables === 'disable'} disabled={action.isPending} onClick={() => action.mutate('disable')}>{t("停用 HTTPS")}</Button>}
        <Button loading={query.isFetching} disabled={action.isPending} onClick={() => void query.refetch()}>{t("刷新状态")}</Button>
      </Space>
      {value.davUrl && <Typography.Paragraph className="muted-note">{t("连接设置需要系统权限，会重连本机的原生 WebDAV 连接，并将单文件上限设为 4 GiB−1。")}</Typography.Paragraph>}
      <Collapse ghost size="small" items={[{ key: 'certificate', label: t("证书与恢复信息"), children: <Descriptions column={1} size="small" items={[
        { key: 'expiry', label: t("证书到期"), children: value.certificate ? new Date(value.certificate.expiresAt).toLocaleDateString(currentLanguage()) : '—' },
        { key: 'fingerprint', label: 'SHA-256', children: <Typography.Text style={{ overflowWrap: 'anywhere' }}>{value.certificate?.fingerprintSha256}</Typography.Text> },
        { key: 'original', label: t("原文件上限"), children: fileLimit(value.originalFileSizeLimitBytes) }
      ]} /> }]} />
    </>}
  </div>;
}
