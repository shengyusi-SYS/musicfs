import { useState } from 'react';
import { Alert, App, Button, Collapse, Form, InputNumber, Radio, Result, Skeleton, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DesktopNetworkSettings } from '../../contracts/desktop';
import { ApiError, type Api } from '../api';
import { Failure } from './feedback';

type NetworkForm = { access: 'local' | 'lan'; port?: number };

export default function DesktopNetwork({ api, scope }: { api: Api; scope: 'management' | 'dav' }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const accessKey = scope === 'management' ? 'managementAccess' : 'davAccess';
  const [managementClosed, setManagementClosed] = useState(false);
  const network = useQuery({ queryKey: ['desktop-network'], queryFn: ({ signal }) => api.desktopNetwork(signal),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2 });
  const save = useMutation({ mutationFn: (settings: Partial<DesktopNetworkSettings>) => api.saveDesktopNetwork(settings), onSuccess: value => {
    client.setQueryData(['desktop-network'], value);
    const url = new URL(location.href);
    if (scope === 'management' && !value.restartRequired && value.active.managementAccess === 'local' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      setManagementClosed(true); return;
    }
    message.success(value.restartRequired ? '设置已保存，重新启动后台后生效' : '访问设置已保存');
    if (!value.restartRequired && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== value.active.port && url.protocol === 'http:') {
      url.port = String(value.active.port); location.assign(url.href);
    }
  } });
  if (network.error instanceof ApiError && network.error.status === 404) return null;
  const value = network.data;
  const settings: NetworkForm | undefined = value && { access: value.settings[accessKey], ...(scope === 'dav' ? { port: value.settings.port } : {}) };
  if (managementClosed) return <Result status="success" title="已关闭局域网管理" subTitle="请在运行 MusicFS 的电脑上继续管理。" />;
  const lanAddresses = (urls: string[]) => urls.filter(url => new URL(url).hostname !== '127.0.0.1').map(url =>
    <Typography.Paragraph key={url}><Typography.Text copyable={{ text: url }}>{url}</Typography.Text></Typography.Paragraph>);
  const options = [{ label: '仅本机', value: 'local' }, { label: '局域网设备', value: 'lan' }];
  return <div className="settings-content">
    <Failure error={network.error} retry={() => void network.refetch()} />
    {network.isPending ? <Skeleton active /> : value && settings && <>
      <Form<NetworkForm> key={JSON.stringify(settings)} layout="vertical" initialValues={settings}
        onFinish={next => save.mutate({ [accessKey]: next.access, ...(scope === 'dav' && next.port !== undefined ? { port: next.port } : {}) })}>
        <Form.Item label="访问设备" name="access" rules={[{ required: true }]}>
          <Radio.Group aria-label={(scope === 'management' ? '管理页面' : 'WebDAV') + '允许访问的设备'} disabled={save.isPending} options={options} />
        </Form.Item>
        {scope === 'management' && value.active.managementAccess === 'lan' && lanAddresses(value.managementUrls)}
        {scope === 'dav' && <Collapse className="network-port-options" ghost items={[{ key: 'port', label: '端口设置', forceRender: true, children:
          <Form.Item label="服务端口" name="port" extra="0 为自动选择。修改端口后，管理页面与播放器的地址都会改变。" rules={[{ required: true, type: 'number', min: 0, max: 65535 }]}>
            <InputNumber min={0} max={65535} precision={0} disabled={save.isPending} aria-label="监听端口" />
          </Form.Item>
        }]} />}
        <Failure error={save.error} /><Button type="primary" htmlType="submit" loading={save.isPending}>保存访问设置</Button>
      </Form>
      {value.restartRequired && <Alert className="feedback" type="info" showIcon title="重新启动 MusicFS 后生效" />}
    </>}
  </div>;
}
