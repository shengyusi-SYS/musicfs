import { useState } from 'react';
import { App, Button, Popover, Select, Space, Spin, Typography } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Api } from '../api';
import { Failure } from './feedback';

/** Policy is loaded only when opened, so browsing sources adds no per-directory polling. */
export function RefreshPolicyControl({ api, instanceId, directoryRef, disabled = false }: {
  api: Api; instanceId: string; directoryRef?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false); const client = useQueryClient(); const { message } = App.useApp();
  const queryKey = ['refresh-policy', instanceId, directoryRef];
  const policy = useQuery({ queryKey, queryFn: ({ signal }) => api.refreshPolicy(instanceId, directoryRef, signal), enabled: open });
  const save = useMutation({ mutationFn: (minutes: number) => api.saveRefreshPolicy(instanceId, minutes, directoryRef),
    onSuccess: value => { client.setQueryData(queryKey, value); message.success(value.intervalMinutes ? '此目录已启用定时更新' : '此目录已改为手动更新'); } });
  return <Popover trigger="click" open={open} onOpenChange={setOpen} title="定时更新此目录" content={<Space orientation="vertical" style={{ maxWidth: 280 }}>
    {policy.isPending ? <Spin size="small" /> : policy.data && <Select aria-label="目录自动更新周期" style={{ width: 260 }} value={policy.data.intervalMinutes} disabled={save.isPending}
      options={[{ value: 0, label: '手动更新（默认）' }, { value: 15, label: '每15分钟' }, { value: 60, label: '每小时' }, { value: 360, label: '每6小时' }, { value: 1440, label: '每天' }, { value: 10080, label: '每周' }]}
      onChange={value => save.mutate(value)} />}
    {policy.data?.nextRunAt && <Typography.Text type="secondary">下次计划：{new Date(policy.data.nextRunAt).toLocaleString()}</Typography.Text>}
    <Failure error={policy.error} retry={() => void policy.refetch()} /><Failure error={save.error} />
  </Space>}><Button icon={<ClockCircleOutlined aria-hidden="true" />} disabled={disabled}>定时更新</Button></Popover>;
}
