import { lazy, Suspense, useState } from 'react';
import { Alert, Badge, Button, Form, Input, Layout, Menu, Skeleton, Typography } from 'antd';
import { ApiOutlined, CloudServerOutlined, FolderOutlined, LogoutOutlined, AppstoreOutlined } from '@ant-design/icons';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createApi, type Api } from './api';

const Sources = lazy(() => import('./pages/sources'));
const Plugins = lazy(() => import('./pages/plugins'));
const Library = lazy(() => import('./pages/library'));
const Connection = lazy(() => import('./pages/connection'));

const pages = {
  sources: { title: '数据源', description: '为每个来源建立独立实例，分别保存配置和授权。' },
  plugins: { title: '插件', description: '安装预构建来源插件，为 MusicFS 接入新的内容。' },
  library: { title: '目录布局', description: '组织对外提供的目录，保留自己的分组与命名。' },
  connection: { title: '服务连接', description: '通过 WebDAV 将音乐目录连接到你的客户端。' }
};
type Page = keyof typeof pages;
function initialToken() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('token');
  if (token) {
    sessionStorage.setItem('musicfs.adminToken', token);
    history.replaceState(null, '', location.pathname + location.search);
  }
  return token ?? sessionStorage.getItem('musicfs.adminToken') ?? '';
}

export function App() {
  const [token, setToken] = useState(initialToken);
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));
  const [api, setApi] = useState(() => createApi(token));
  function connect(next: string) {
    client.clear(); sessionStorage.setItem('musicfs.adminToken', next); setApi(createApi(next)); setToken(next);
  }
  return <QueryClientProvider client={client}>{token
    ? <Workspace key={token} api={api} disconnect={() => connect('')} />
    : <div className="access-screen"><section className="access-panel"><Typography.Text className="eyebrow">MUSICFS / 管理入口</Typography.Text>
      <Typography.Title level={1}>连接你的音乐目录</Typography.Title><Typography.Paragraph type="secondary">输入此服务的管理令牌。它与播放器使用的 WebDAV 密码分别管理。</Typography.Paragraph>
      <Form<{ token: string }> layout="vertical" onFinish={values => connect(values.token.trim())}>
        <Form.Item label="管理令牌" name="token" rules={[{ required: true, whitespace: true, message: '请输入管理令牌' }]}><Input.Password autoComplete="off" /></Form.Item>
        <Button type="primary" htmlType="submit" block>连接服务</Button>
      </Form></section></div>}</QueryClientProvider>;
}

function Workspace({ api, disconnect }: { api: Api; disconnect: () => void }) {
  const [page, setPage] = useState<Page>('sources');
  const status = useQuery({ queryKey: ['status'], queryFn: ({ signal }) => api.status(signal) });
  return <Layout className="workspace"><aside className="sidebar">
    <a href="#" className="wordmark" onClick={event => { event.preventDefault(); setPage('sources'); }}>MusicFS<span>音乐文件服务</span></a>
    <div className="nav-caption">工作区</div><Menu mode="inline" selectedKeys={[page]} onClick={({ key }) => setPage(key as Page)} items={[
      { key: 'sources', icon: <ApiOutlined />, label: '数据源' }, { key: 'plugins', icon: <AppstoreOutlined />, label: '插件' },
      { key: 'library', icon: <FolderOutlined />, label: '目录布局' }, { key: 'connection', icon: <CloudServerOutlined />, label: '服务连接' }
    ]} />
    <footer className="sidebar-footer"><Badge status={status.isSuccess ? 'success' : status.isError ? 'error' : 'processing'} text={status.isSuccess ? status.data.host === 'desktop' ? '桌面服务已连接' : 'Worker 已连接' : status.isError ? '服务连接失败' : '正在连接'} />
      <div className="version">{status.data?.version ?? 'MusicFS'}</div><Button type="text" icon={<LogoutOutlined />} onClick={disconnect}>断开管理连接</Button></footer>
  </aside><Layout className="main-layout"><header className="topbar"><span>个人音乐空间</span><Typography.Text type="secondary">只读 WebDAV</Typography.Text><Button className="mobile-disconnect" type="text" icon={<LogoutOutlined />} onClick={disconnect} aria-label="断开管理连接" /></header>
    <main className="main-content"><div className="page-heading"><div><div className="eyebrow">工作区 / {pages[page].title}</div><Typography.Title level={1}>{pages[page].title}</Typography.Title><Typography.Paragraph type="secondary">{pages[page].description}</Typography.Paragraph></div>
    </div>
    {status.isError && <Alert showIcon type="error" title="无法连接管理接口" description={status.error.message} action={<div><Button onClick={() => void status.refetch()}>重试</Button><Button onClick={disconnect}>重新输入令牌</Button></div>} />}
    {status.isPending ? <Skeleton active /> : status.isSuccess && <Suspense fallback={<Skeleton active />}>
      {page === 'sources' && <Sources api={api} showPlugins={() => setPage('plugins')} />}
      {page === 'plugins' && <Plugins api={api} />}
      {page === 'library' && <Library api={api} />}
      {page === 'connection' && <Connection api={api} />}
    </Suspense>}</main>
  </Layout></Layout>;
}
