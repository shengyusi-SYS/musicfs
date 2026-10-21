import { lazy, Suspense, useState } from 'react';
import { Alert, Badge, Button, Dropdown, Form, Input, Layout, Menu, Skeleton, Typography } from 'antd';
import { ApiOutlined, FolderOutlined, AppstoreOutlined, LinkOutlined, LogoutOutlined, MoreOutlined, PoweroffOutlined } from '@ant-design/icons';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from 'react-error-boundary';
import { ApiError, createApi, type Api } from './api';
import { Failure } from './components/feedback';
import { useWorkspaceNavigation } from './components/workspace-navigation';
import type { LayoutDraft } from './pages/layout-editor';

const Sources = lazy(() => import('./pages/sources'));
const Plugins = lazy(() => import('./pages/plugins'));
const Library = lazy(() => import('./pages/library'));
const Connection = lazy(() => import('./pages/connection'));
const titles = { sources: '音乐来源', library: '音乐目录', connection: '连接与挂载', plugins: '插件' };

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
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } } }));
  const [api, setApi] = useState(() => createApi(token));
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  function connect(next: string) {
    client.clear(); sessionStorage.setItem('musicfs.adminToken', next); setApi(createApi(next)); setToken(next); setError(null);
  }
  async function signIn(next: string) {
    setConnecting(true); setError(null);
    try { await createApi(next).status(); connect(next); }
    catch (value) { setError(value instanceof ApiError && value.status === 401 ? new Error('管理令牌不正确') : value as Error); }
    finally { setConnecting(false); }
  }
  return <QueryClientProvider client={client}>{token
    ? <Workspace key={token} api={api} disconnect={() => connect('')} />
    : <div className="access-screen"><section className="access-panel"><div className="access-brand">MusicFS</div>
      <Typography.Title level={1}>打开你的音乐空间</Typography.Title>
      <Form<{ token: string }> layout="vertical" onFinish={values => void signIn(values.token.trim())}>
        <Form.Item label="管理令牌" name="token" rules={[{ required: true, whitespace: true, message: '请输入管理令牌' }]}><Input.Password autoComplete="off" autoFocus /></Form.Item>
        <Failure error={error} /><Button type="primary" htmlType="submit" block loading={connecting}>连接</Button>
      </Form></section></div>}</QueryClientProvider>;
}

function Workspace({ api, disconnect }: { api: Api; disconnect: () => void }) {
  const client = useQueryClient();
  const { page, navigate } = useWorkspaceNavigation();
  const [stopped, setStopped] = useState(false);
  const [newPlugin, setNewPlugin] = useState<string | null>(null);
  const [installRequested, setInstallRequested] = useState(false);
  const [libraryPath, setLibraryPath] = useState('/');
  const [connectionTab, setConnectionTab] = useState<'mount' | 'dav'>('mount');
  const [draft, setDraft] = useState<LayoutDraft | null>(null);
  const status = useQuery({ queryKey: ['status'], queryFn: ({ signal }) => api.status(signal), staleTime: Infinity });
  const quit = useMutation({ mutationFn: () => api.quitDesktop(), onSuccess: async () => { await client.cancelQueries(); setStopped(true); } });
  if (stopped) return <div className="access-screen"><section className="access-panel"><div className="access-brand">MusicFS</div><Typography.Title level={2}>正在退出 MusicFS</Typography.Title>
    <Typography.Paragraph type="secondary">下次使用时，重新打开桌面程序即可。</Typography.Paragraph></section></div>;
  const addSource = (pluginId: string) => { setNewPlugin(pluginId); navigate('sources'); };
  return <Layout className="workspace"><aside className="sidebar">
    <a href="?page=sources" className="wordmark" onClick={event => { event.preventDefault(); navigate('sources'); }}>MusicFS<span>你的音乐，随处可听</span></a>
    <Menu aria-label="主导航" mode="inline" selectedKeys={[page]} onClick={({ key }) => navigate(key as typeof page)} items={[
      { key: 'sources', icon: <ApiOutlined aria-hidden="true" />, label: '音乐来源' },
      { key: 'library', icon: <FolderOutlined aria-hidden="true" />, label: <>音乐目录{draft && <span className="unsaved-dot" aria-label="有未保存的目录修改" />}</> },
      { key: 'connection', icon: <LinkOutlined aria-hidden="true" />, label: '连接与挂载' },
      { type: 'divider' }, { key: 'plugins', icon: <AppstoreOutlined aria-hidden="true" />, label: '插件' }
    ]} />
    <footer className="sidebar-footer"><Badge status={status.isSuccess ? 'success' : status.isError ? 'error' : 'processing'} text={status.isSuccess ? status.data.host === 'desktop' ? '本机服务' : '云端服务' : status.isError ? '连接失败' : '正在连接'} />
      <div className="version">{status.data?.version}</div>
      {status.data?.host === 'desktop' && <Button type="text" icon={<PoweroffOutlined aria-hidden="true" />} loading={quit.isPending} onClick={() => quit.mutate()}>退出 MusicFS</Button>}
      <Button type="text" icon={<LogoutOutlined aria-hidden="true" />} onClick={disconnect}>切换服务</Button>
    </footer>
  </aside><Layout className="main-layout"><main className="main-content"><header className="page-heading"><Typography.Title level={1}>{titles[page]}</Typography.Title>
    <Dropdown trigger={['click']} menu={{ items: [
      { key: 'disconnect', label: '切换服务', onClick: disconnect },
      ...(status.data?.host === 'desktop' ? [{ key: 'quit', label: '退出 MusicFS', disabled: quit.isPending, onClick: () => quit.mutate() }] : [])
    ] }}><Button className="mobile-disconnect" type="text" icon={<MoreOutlined aria-hidden="true" />} aria-label="服务操作" /></Dropdown></header>
    <Failure error={quit.error} />
    {status.isError && <Alert showIcon type="error" title="无法连接 MusicFS" description={status.error.message} action={<div><Button onClick={() => void status.refetch()}>重试</Button><Button onClick={disconnect}>更换令牌</Button></div>} />}
    {status.isPending ? <Skeleton active /> : status.isSuccess && <ErrorBoundary key={page} fallbackRender={() => <Alert type="error" showIcon title="页面未能加载" action={<Button onClick={() => location.reload()}>重新打开</Button>} />}><Suspense fallback={<Skeleton active />}>
      {page === 'sources' && <Sources api={api} showPlugins={() => { setInstallRequested(true); navigate('plugins'); }} showLibrary={() => navigate('library')} initialPluginId={newPlugin} consumePlugin={() => setNewPlugin(null)} />}
      {page === 'plugins' && <Plugins api={api} addSource={addSource} startInstalling={installRequested} consumeInstall={() => setInstallRequested(false)} />}
      {page === 'library' && <Library api={api} path={libraryPath} setPath={setLibraryPath} draft={draft} setDraft={setDraft} showSources={() => navigate('sources')} showConnection={() => navigate('connection')} />}
      {page === 'connection' && <Connection api={api} tab={connectionTab} setTab={setConnectionTab} />}
    </Suspense></ErrorBoundary>}</main></Layout></Layout>;
}
