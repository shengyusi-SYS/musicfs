import { Alert, Descriptions, Input, Skeleton, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { Api } from '../api';
import { Failure } from '../components/feedback';

export default function Connection({ api }: { api: Api }) {
  const connection = useQuery({ queryKey: ['connection'], queryFn: ({ signal }) => api.connection(signal) });
  const value = connection.data; const url = value ? new URL(value.davPath, location.origin).href : '';
  return <section className="surface"><Typography.Title level={3}>WebDAV 读取连接</Typography.Title><Typography.Paragraph type="secondary">将以下地址和读取凭据填入 OpenList、支持 WebDAV 的播放器或其他客户端。</Typography.Paragraph>
    <Failure error={connection.error} retry={() => void connection.refetch()} />{connection.isPending ? <Skeleton active /> : value && <Descriptions column={1} layout="vertical" items={[
      { key: 'url', label: 'WebDAV 地址', children: <Typography.Text copyable={{ text: url }} className="connection-url">{url}</Typography.Text> },
      { key: 'username', label: '用户名', children: <Typography.Text copyable>{value.username}</Typography.Text> },
      { key: 'password', label: '读取密码', children: <Input.Password value={value.password} readOnly autoComplete="off" aria-label="WebDAV 读取密码" /> }
    ]} />}
    <Alert type="info" showIcon title="目录以只读方式提供" description="读取凭据只用于访问文件。管理令牌用于当前管理页面，请分别保管。" />
  </section>;
}
