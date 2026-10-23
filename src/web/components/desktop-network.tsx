import { useState } from 'react';
import { Alert, App, Button, Form, InputNumber, Radio, Result, Skeleton, Space, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DesktopNetworkSettings } from '../../contracts/desktop';
import { ApiError, type Api } from '../api';
import { Failure } from './feedback';

export default function DesktopNetwork({ api }: { api: Api }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const [managementClosed, setManagementClosed] = useState(false);
  const network = useQuery({ queryKey: ['desktop-network'], queryFn: ({ signal }) => api.desktopNetwork(signal),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2 });
  const save = useMutation({ mutationFn: (settings: DesktopNetworkSettings) => api.saveDesktopNetwork(settings), onSuccess: value => {
    client.setQueryData(['desktop-network'], value);
    const url = new URL(location.href);
    if (!value.restartRequired && value.active.managementAccess === 'local' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      setManagementClosed(true); return;
    }
    message.success(value.restartRequired ? '设置已保存，重新启动后台后生效' : '网络设置已保存');
    if (!value.restartRequired && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== value.active.port && url.protocol === 'http:') {
      url.port = String(value.active.port); location.assign(url.href);
    }
  } });
  if (network.error instanceof ApiError && network.error.status === 404) return null;
  const value = network.data;
  if (managementClosed) return <Result status="success" title="已关闭局域网管理" subTitle="请在运行 MusicFS 的电脑上继续管理。" />;
  const lanAddresses = (urls: string[]) => urls.filter(url => new URL(url).hostname !== '127.0.0.1').map(url =>
    <Typography.Paragraph key={url}><Typography.Text copyable={{ text: url }}>{url}</Typography.Text></Typography.Paragraph>);
  const options = [{ label: '仅本机', value: 'local' }, { label: '局域网设备', value: 'lan' }];
  return <div className="settings-content">
    <Failure error={network.error} retry={() => void network.refetch()} />
    {network.isPending ? <Skeleton active /> : value && <>
      <Form<DesktopNetworkSettings> key={JSON.stringify(value.settings)} layout="vertical" initialValues={value.settings} onFinish={settings => save.mutate(settings)}>
        <Form.Item label="管理页面" name="managementAccess" extra="供其他设备管理音乐库，使用管理登录或手机访问二维码。" rules={[{ required: true }]}>
          <Radio.Group aria-label="管理页面允许访问的设备" disabled={save.isPending} options={options} />
        </Form.Item>
        {value.active.managementAccess === 'lan' && lanAddresses(value.managementUrls)}
        <Form.Item label="WebDAV" name="davAccess" extra="供播放器读取音乐，使用独立的 WebDAV 用户名和密码。" rules={[{ required: true }]}>
          <Radio.Group aria-label="WebDAV 允许访问的设备" disabled={save.isPending} options={options} />
        </Form.Item>
        {value.active.davAccess === 'lan' && lanAddresses(value.davUrls)}
        <Form.Item label="共用端口" name="port" extra="0 为自动选择；固定端口便于播放器保存地址。" rules={[{ required: true, type: 'number', min: 0, max: 65535 }]}>
          <InputNumber min={0} max={65535} precision={0} disabled={save.isPending} aria-label="监听端口" />
        </Form.Item>
        <Failure error={save.error} /><Space><Button type="primary" htmlType="submit" loading={save.isPending}>保存</Button></Space>
      </Form>
      {value.restartRequired && <Alert className="feedback" type="info" showIcon title="重新启动 MusicFS 后生效" />}
    </>}
  </div>;
}
