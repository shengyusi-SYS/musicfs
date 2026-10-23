import { useState } from 'react';
import { Alert, App, Button, Form, InputNumber, Radio, Result, Skeleton, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DesktopNetworkSettings } from '../../contracts/desktop';
import { ApiError, type Api } from '../api';
import { Failure } from './feedback';

type NetworkForm = { access: 'local' | 'lan'; port: number };

export default function DesktopNetwork({ api, scope }: { api: Api; scope: 'management' | 'dav' }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const accessKey = scope === 'management' ? 'managementAccess' : 'davAccess';
  const portKey = scope === 'management' ? 'managementPort' : 'davPort';
  const [managementClosed, setManagementClosed] = useState(false);
  const network = useQuery({ queryKey: ['desktop-network'], queryFn: ({ signal }) => api.desktopNetwork(signal),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2 });
  const save = useMutation({ mutationFn: (settings: Partial<DesktopNetworkSettings>) => api.saveDesktopNetwork(settings), onSuccess: value => {
    client.setQueryData(['desktop-network'], value);
    const url = new URL(location.href);
    if (scope === 'management' && value.active.managementAccess === 'local' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      setManagementClosed(true); return;
    }
    message.success('访问设置已保存');
    if (scope === 'management' && Number(url.port || 80) !== value.active.managementPort && url.protocol === 'http:') {
      url.port = String(value.active.managementPort); location.assign(url.href);
    }
  } });
  if (network.error instanceof ApiError && network.error.status === 404) return null;
  const value = network.data;
  const settings: NetworkForm | undefined = value && { access: value.settings[accessKey], port: value.settings[portKey] };
  const restartRequired = value && (value.settings[accessKey] !== value.active[accessKey] || value.settings[portKey] !== 0 && value.settings[portKey] !== value.active[portKey]);
  if (managementClosed) return <Result status="success" title="已关闭局域网管理" subTitle="请在运行 MusicFS 的电脑上继续管理。" />;
  const lanAddresses = (urls: string[]) => urls.filter(url => new URL(url).hostname !== '127.0.0.1').map(url =>
    <Typography.Paragraph key={url}><Typography.Text copyable={{ text: url }}>{url}</Typography.Text></Typography.Paragraph>);
  const options = [{ label: '仅本机', value: 'local' }, { label: '局域网设备', value: 'lan' }];
  return <div className="settings-content">
    <Failure error={network.error} retry={() => void network.refetch()} />
    {network.isPending ? <Skeleton active /> : value && settings && <>
      <Form<NetworkForm> key={JSON.stringify(settings)} layout="vertical" initialValues={settings}
        onFinish={next => save.mutate({ [accessKey]: next.access, [portKey]: next.port })}>
        <Form.Item label="访问设备" name="access" rules={[{ required: true }]}>
          <Radio.Group aria-label={(scope === 'management' ? '管理页面' : 'WebDAV') + '允许访问的设备'} disabled={save.isPending} options={options} />
        </Form.Item>
        {scope === 'management' && value.active.managementAccess === 'lan' && lanAddresses(value.managementUrls)}
        <Form.Item label={scope === 'management' ? '管理端口' : 'WebDAV 端口'} name="port" extra={`0 为自动选择，当前使用 ${value.active[portKey]}。`} rules={[{ required: true, type: 'number', min: 0, max: 65535 }]}>
          <InputNumber min={0} max={65535} precision={0} disabled={save.isPending} aria-label={scope === 'management' ? '管理端口' : 'WebDAV 端口'} />
        </Form.Item>
        <Failure error={save.error} /><Button type="primary" htmlType="submit" loading={save.isPending}>保存访问设置</Button>
      </Form>
      {restartRequired && <Alert className="feedback" type="info" showIcon title="端口被占用，当前使用上方显示的地址" />}
    </>}
  </div>;
}
