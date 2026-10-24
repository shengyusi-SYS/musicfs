import { App, Button, Select, Skeleton, Space, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiagnosticSettings } from '../../contracts/diagnostics';
import type { Api } from '../api';
import { t } from '../i18n';
import { Failure } from './feedback';

export default function DesktopDiagnostics({ api }: { api: Api }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const query = useQuery({ queryKey: ['desktop-diagnostics'], queryFn: () => api.diagnostics() });
  const save = useMutation({ mutationFn: (settings: DiagnosticSettings) => api.saveDiagnostics(settings),
    onSuccess: value => { client.setQueryData(['desktop-diagnostics'], value); message.success(t('日志设置已生效')); } });
  const download = useMutation({ mutationFn: () => api.downloadDiagnostics(), onSuccess: blob => {
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = 'musicfs-diagnostics.zip'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } });
  const value = query.data;
  const labels = { trace: t('跟踪'), debug: t('详细'), info: t('常规'), warning: t('警告和错误'), error: t('仅错误'), fatal: t('仅致命错误') };
  return <section className="surface"><div className="section-heading"><Typography.Title level={3}>{t('日志与诊断')}</Typography.Title>
    <Button onClick={() => download.mutate()} loading={download.isPending}>{t('下载日志')}</Button></div>
    <Failure error={query.error} retry={() => void query.refetch()} />
    {query.isPending ? <Skeleton active /> : value && <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap><label htmlFor="application-log-level">{t('应用日志')}</label><Select id="application-log-level" style={{ minWidth: 160 }} value={value.settings.level}
        disabled={save.isPending} options={Object.entries(labels).map(([level, label]) => ({ value: level, label }))}
        onChange={level => save.mutate({ ...value.settings, level })} />
        {value.nativeAvailable && <><label htmlFor="native-log-level">{t('挂载与缓存日志')}</label><Select id="native-log-level" style={{ minWidth: 160 }} value={value.settings.nativeLevel}
          disabled={save.isPending} options={[{ value: 'ERROR', label: t('仅错误') }, { value: 'NOTICE', label: t('常规') }, { value: 'INFO', label: t('运行信息') }, { value: 'DEBUG', label: t('详细') }]}
          onChange={nativeLevel => save.mutate({ ...value.settings, nativeLevel })} /></>}
      </Space>
      <Typography.Text type="secondary">{t('复现问题前切到详细，完成后下载日志。设置立即生效，无需重启。')}</Typography.Text>
      <Typography.Text type="secondary" copyable>{value.directory}</Typography.Text>
      {!value.fileLogging && <Typography.Text type="warning">{t('文件日志不可用，应用日志正输出到终端。')}</Typography.Text>}
    </Space>}
    <Failure error={save.error ?? download.error} />
  </section>;
}
