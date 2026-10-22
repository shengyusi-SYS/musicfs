import { useEffect, useState } from 'react';
import { Alert, App, Button, Collapse, Form, InputNumber, Modal, Select, Space, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MountCacheStatus } from '../../contracts/mounts';
import type { ReadCacheSettings, ReadCacheStatus } from '../../contracts/read-cache';
import type { Api } from '../api';
import { Failure } from './feedback';

function CacheDuration({ value = 0, onChange, unit, id }: { value?: number; onChange?: (value: number) => void; unit: 'seconds' | 'hours'; id?: string }) {
  const day = unit === 'seconds' ? 86400 : 24;
  const periods = [{ value: 30 * day, label: '1 个月（30 天）' }, { value: 365 * day, label: '1 年（365 天）' }, { value: 0, label: '长期保留' }];
  const [custom, setCustom] = useState(!periods.some(period => period.value === value));
  const isCustom = custom || !periods.some(period => period.value === value);
  return <Space.Compact block><Select {...(id === undefined ? {} : { id })} aria-label="缓存时长" style={{ minWidth: 180, flex: 1 }} value={isCustom ? 'custom' : value}
    options={[...periods, { value: 'custom', label: '自定义' }]} onChange={next => {
      setCustom(next === 'custom'); if (typeof next === 'number') onChange?.(next);
    }} />{isCustom && <InputNumber aria-label={unit === 'seconds' ? '缓存秒数' : '缓存小时数'} value={value} min={0} max={unit === 'seconds' ? 2_147_483_647 : 2_147_483} precision={0}
      suffix={unit === 'seconds' ? '秒' : '小时'} onChange={next => { if (next !== null) onChange?.(next); }} />}</Space.Compact>;
}

export function MountCacheFields() {
  return <><Form.Item label="挂载目录缓存" name="directoryCacheSeconds" extra="MusicFS 发布有变化的本机目录后会主动更新；远程目录也可手动刷新。" rules={[{ required: true, type: 'integer', min: 0, max: 2_147_483_647 }]}>
    <CacheDuration unit="seconds" />
  </Form.Item><Form.Item label="读取缓存上限（MiB）" name="fileCacheMaxMiB" extra="0：关闭缓存。8192 MiB = 8 GiB。" rules={[{ required: true, type: 'integer', min: 0, max: 1_048_576 }]}>
    <InputNumber min={0} max={1_048_576} precision={0} style={{ width: '100%' }} />
  </Form.Item><Form.Item label="未使用音频缓存保留时间" name="fileCacheMaxAgeHours" rules={[{ required: true, type: 'integer', min: 0, max: 2_147_483 }]}>
    <CacheDuration unit="hours" />
  </Form.Item></>;
}

const cacheModes = { off: '已关闭', minimal: '最少缓存', writes: '写入缓存', full: '读取缓存' };
export function CacheSummary({ value }: { value: ReadCacheStatus | MountCacheStatus }) {
  return <><div className="cache-summary"><strong>{value.bytesUsed === null ? '—' : (value.bytesUsed / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' MiB'}</strong>
    <span>{value.files === null ? '尚无占用统计' : value.files.toLocaleString() + ' 个缓存文件'} · {value.actualMode ? cacheModes[value.actualMode] : value.state === 'inactive' ? '未运行' : '暂不可用'}</span></div>
    {value.message && <Alert className="feedback" type="warning" showIcon title={value.message} />}
    <Collapse ghost size="small" items={[{ key: 'location', label: '缓存位置与统计时间', children: <><Typography.Paragraph copyable style={{ overflowWrap: 'anywhere' }}>{value.directory}</Typography.Paragraph><Typography.Text type="secondary">{new Date(value.sampledAt).toLocaleString()}</Typography.Text></> }]} />
  </>;
}

export function SharedReadCacheDialog({ api, onClose }: { api: Api; onClose: () => void }) {
  const client = useQueryClient(); const { message } = App.useApp(); const [form] = Form.useForm<ReadCacheSettings>();
  const status = useQuery({ queryKey: ['desktop-read-cache'], queryFn: ({ signal }) => api.desktopReadCache(signal), refetchOnReconnect: false });
  const settings = status.data?.settings;
  useEffect(() => { if (settings) form.setFieldsValue(settings); }, [form, settings?.maxMiB, settings?.maxAgeHours]);
  function update(value: ReadCacheStatus) { client.setQueryData(['desktop-read-cache'], value); form.setFieldsValue(value.settings); }
  const configure = useMutation({ mutationFn: (settings: ReadCacheSettings) => api.configureDesktopReadCache(settings), onSuccess: value => { update(value); message.success('缓存设置已保存'); } });
  const clear = useMutation({ mutationFn: () => api.clearDesktopReadCache(), onSuccess: value => { update(value); message.success('缓存已清理'); } });
  const changing = configure.isPending || clear.isPending; const value = status.data;
  return <Modal title="WebDAV 读取缓存" open onCancel={onClose} footer={null} destroyOnHidden>
    <Typography.Paragraph type="secondary">供直接连接本机 WebDAV 的播放器使用。</Typography.Paragraph>
    <Failure error={status.error} retry={() => void status.refetch()} />
    {value && <><CacheSummary value={value} />
      <Form form={form} layout="vertical" initialValues={value.settings} onFinish={settings => configure.mutate(settings)}>
        <Form.Item label="缓存上限（MiB）" name="maxMiB" extra="0：关闭缓存。16384 MiB = 16 GiB。" rules={[{ required: true, type: 'integer', min: 0, max: 1_048_576 }]}><InputNumber min={0} max={1_048_576} precision={0} style={{ width: '100%' }} /></Form.Item>
        <Form.Item label="未使用音频缓存保留时间" name="maxAgeHours" rules={[{ required: true, type: 'integer', min: 0, max: 2_147_483 }]}><CacheDuration unit="hours" /></Form.Item>
        <Failure error={configure.error} /><Failure error={clear.error} />
        <div className="dialog-actions"><Space><Button danger disabled={changing} loading={clear.isPending} onClick={() => clear.mutate()}>清理缓存</Button><Button loading={status.isFetching} disabled={changing} onClick={() => void status.refetch()}>刷新统计</Button></Space>
          <Button type="primary" htmlType="submit" loading={configure.isPending} disabled={changing}>保存</Button></div>
      </Form>
    </>}
  </Modal>;
}
