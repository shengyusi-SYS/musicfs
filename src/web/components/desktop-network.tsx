import { Alert, App, Button, Form, InputNumber, Radio, Skeleton, Space, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DesktopNetworkSettings } from '../../contracts/desktop';
import { ApiError, type Api } from '../api';
import { Failure } from './feedback';

export default function DesktopNetwork({ api }: { api: Api }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const network = useQuery({ queryKey: ['desktop-network'], queryFn: ({ signal }) => api.desktopNetwork(signal),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2 });
  const save = useMutation({ mutationFn: (settings: DesktopNetworkSettings) => api.saveDesktopNetwork(settings), onSuccess: value => {
    client.setQueryData(['desktop-network'], value); message.success(value.restartRequired ? '设置已保存，重新启动后台后生效' : '网络设置已保存');
  } });
  if (network.error instanceof ApiError && network.error.status === 404) return null;
  const value = network.data;
  return <div className="settings-content">
    <Failure error={network.error} retry={() => void network.refetch()} />
    {network.isPending ? <Skeleton active /> : value && <>
      <Typography.Paragraph><Tag>{value.active.access === 'lan' ? '同一网络的设备可连接' : '当前仅供本机使用'}</Tag></Typography.Paragraph>
      {value.active.access === 'lan' && value.davUrls.filter(url => new URL(url).hostname !== '127.0.0.1').map(url =>
        <Typography.Paragraph key={url}><Typography.Text copyable={{ text: url }}>{url}</Typography.Text></Typography.Paragraph>)}
      <Form<DesktopNetworkSettings> layout="vertical" initialValues={value.settings} onFinish={settings => save.mutate(settings)}>
        <Form.Item label="允许访问的设备" name="access" rules={[{ required: true }]}><Radio.Group disabled={save.isPending} options={[
          { label: '仅本机', value: 'local' }, { label: '局域网设备', value: 'lan' }
        ]} /></Form.Item>
        <Form.Item label="端口" name="port" extra="0 为自动选择；填写固定端口，便于播放器保存地址。" rules={[{ required: true, type: 'number', min: 0, max: 65535 }]}>
          <InputNumber min={0} max={65535} precision={0} disabled={save.isPending} aria-label="监听端口" />
        </Form.Item>
        <Failure error={save.error} /><Space><Button type="primary" htmlType="submit" loading={save.isPending}>保存</Button></Space>
      </Form>
      {value.restartRequired && <Alert className="feedback" type="info" showIcon title="重新启动 MusicFS 后生效" />}
    </>}
  </div>;
}
