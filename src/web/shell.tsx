import { t, messageText } from './i18n';
import { Activity, lazy, Suspense, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Collapse, Dropdown, Form, Input, Layout, Menu, Skeleton, Typography } from 'antd';
import { FolderOutlined, AppstoreOutlined, LinkOutlined, MoreOutlined, SettingOutlined } from '@ant-design/icons';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from 'react-error-boundary';
import { createApi, type Api } from './api';
import { Failure } from './components/feedback';
import { useWorkspaceNavigation } from './components/workspace-navigation';
import type { LayoutDraft } from './pages/layout-draft';
import { PhoneAccess } from './components/phone-access';
import { LanguageSwitch } from './components/language-switch';
import type { ManagementAccess, ManagementLogin } from '../contracts/management-auth';

const MusicWorkspace = lazy(() => import('./pages/music-workspace'));
const Plugins = lazy(() => import('./pages/plugins'));
const Connection = lazy(() => import('./pages/connection'));
const Settings = lazy(() => import('./pages/settings'));
const titles = { get library() { return t("音乐库"); }, get connection() { return t("连接与挂载"); }, get plugins() { return t("插件"); }, get settings() { return t("设置"); } };

let entry: Promise<void> | undefined;
let entryError: Error | null = null;
function initializeSession(api: Api) {
  // A one-time entry is consumed once, including React StrictMode remounts.
  entry ??= (async () => {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const ticket = fragment.get('ticket');
    const token = fragment.get('token') ?? sessionStorage.getItem('musicfs.adminToken');
    sessionStorage.removeItem('musicfs.adminToken');
    if (ticket || token) history.replaceState(null, '', location.pathname + location.search);
    if (ticket) await api.exchangeTicket(ticket);
    else if (token) await api.bootstrap(token);
  })().catch(error => { entryError = error instanceof Error ? error : new Error(t("自动登录未完成，请重新打开入口。")); });
  return entry;
}

export function App() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } } }));
  return <QueryClientProvider client={client}><ManagementSession /></QueryClientProvider>;
}

function ManagementSession() {
  const client = useQueryClient();
  const [api] = useState(() => createApi('', fetch, () => { void client.invalidateQueries({ queryKey: ['access'] }); }));
  const access = useQuery({ queryKey: ['access'], queryFn: async () => { await initializeSession(api); return api.access(); }, staleTime: Infinity });
  const logout = useMutation({ mutationFn: () => api.logout(), onSuccess: async () => {
    await client.cancelQueries(); client.removeQueries({ predicate: query => query.queryKey[0] !== 'access' }); entryError = null;
    client.setQueryData(['access'], { authenticated: false, passwordConfigured: access.data?.passwordConfigured ?? false } satisfies ManagementAccess);
    await client.invalidateQueries({ queryKey: ['access'] });
  } });
  async function connected() {
    entryError = null; await client.invalidateQueries({ queryKey: ['access'] });
  }
  if (access.data?.authenticated) return <Workspace api={api} disconnect={() => logout.mutate()} logoutError={logout.error} />;
  return <div className="access-screen"><section className="access-panel"><div className="access-brand-row"><div className="access-brand">MusicFS</div><LanguageSwitch /></div>
    <Typography.Title level={1}>{t("打开你的音乐空间")}</Typography.Title>
    {access.isPending ? <Skeleton active /> : access.isError ? <Failure error={access.error} retry={() => void access.refetch()} />
      : <ManagementSignIn api={api} passwordConfigured={access.data.passwordConfigured} onConnected={connected} />}
  </section></div>;
}

function ManagementSignIn({ api, passwordConfigured, onConnected }: { api: Api; passwordConfigured: boolean; onConnected(): Promise<void> }) {
  const login = useMutation({ mutationFn: (values: ManagementLogin) => api.login(values.username.trim(), values.password, values.rememberMe), onSuccess: onConnected });
  const bootstrap = useMutation({ mutationFn: (token: string) => api.bootstrap(token.trim()), onSuccess: onConnected });
  const tokenForm = <Form<{ token: string }> layout="vertical" onFinish={values => bootstrap.mutate(values.token)}>
    <Typography.Paragraph type="secondary">{t("云端请使用部署时设置的 ADMIN_TOKEN；桌面版可重新运行 MusicFS 获取登录入口。")}</Typography.Paragraph>
    <Form.Item label={t("管理令牌")} name="token" rules={[{ required: true, whitespace: true, message: t("请输入管理令牌") }]}><Input.Password autoComplete="off" /></Form.Item>
    <Failure error={bootstrap.error} /><Button type={passwordConfigured ? 'default' : 'primary'} htmlType="submit" block loading={bootstrap.isPending}>{t("连接")}</Button>
  </Form>;
  return <><Failure error={entryError} />{passwordConfigured ? <><Form<ManagementLogin> layout="vertical" initialValues={{ rememberMe: true }} onFinish={values => login.mutate(values)}>
    <Form.Item label={t("用户名")} name="username" rules={[{ required: true, whitespace: true, message: t("请输入用户名") }]}><Input autoComplete="username" autoFocus /></Form.Item>
    <Form.Item label={t("密码")} name="password" rules={[{ required: true, message: t("请输入密码") }]}><Input.Password autoComplete="current-password" /></Form.Item>
    <Form.Item name="rememberMe" valuePropName="checked"><Checkbox>{t("记住登录")}</Checkbox></Form.Item>
    <Failure error={login.error} /><Button type="primary" htmlType="submit" block loading={login.isPending}>{t("登录")}</Button>
  </Form><Collapse ghost items={[{ key: 'bootstrap', label: t("使用管理令牌"), children: tokenForm }]} /></>
    : tokenForm}</>;
}

function Workspace({ api, disconnect, logoutError }: { api: Api; disconnect: () => void; logoutError: Error | null }) {
  const client = useQueryClient();
  const { page, navigate } = useWorkspaceNavigation();
  const [stopped, setStopped] = useState(false);
  const [newPlugin, setNewPlugin] = useState<string | null>(null);
  const [installRequested, setInstallRequested] = useState(false);
  const [addAfterInstall, setAddAfterInstall] = useState(false);
  const [connectionTab, setConnectionTab] = useState<'mount' | 'dav'>('mount');
  const [draft, setDraft] = useState<LayoutDraft | null>(null);
  const [librarySidebar, setLibrarySidebar] = useState<HTMLDivElement | null>(null);
  const [phoneOpen, setPhoneOpen] = useState(() => new URLSearchParams(location.search).get('phone') === '1');
  const [quitFailed, setQuitFailed] = useState(() => new URLSearchParams(location.search).get('quitFailed') === '1');
  function closePhone() {
    setPhoneOpen(false); const url = new URL(location.href); url.searchParams.delete('phone'); history.replaceState(null, '', url);
  }
  const status = useQuery({ queryKey: ['status'], queryFn: ({ signal }) => api.status(signal), staleTime: Infinity });
  const quit = useMutation({ mutationFn: () => api.quitDesktop(), onSuccess: async () => { await client.cancelQueries(); setStopped(true); } });
  if (stopped) return <div className="access-screen"><section className="access-panel"><div className="access-brand">MusicFS</div><Typography.Title level={2}>{t("正在退出 MusicFS")}</Typography.Title>
    <Typography.Paragraph type="secondary">{t("下次使用时，重新运行 MusicFS 即可。")}</Typography.Paragraph></section></div>;
  const addSource = (pluginId: string) => { setNewPlugin(pluginId); navigate('library'); };
  const serviceControl = <Dropdown trigger={['click']} menu={{ items: [
    { key: 'disconnect', label: t("退出登录"), onClick: disconnect },
    ...(status.data?.host === 'desktop' ? [{ key: 'phone', label: t("手机访问"), onClick: () => setPhoneOpen(true) }] : []),
    ...(status.data?.host === 'desktop' ? [{ key: 'quit', label: t("退出 MusicFS"), disabled: quit.isPending, onClick: () => quit.mutate() }] : [])
  ] }}><Button className="mobile-disconnect" type="text" icon={<MoreOutlined aria-hidden="true" />} aria-label={t("服务操作")} /></Dropdown>;
  return <Layout className={'workspace' + (page === 'library' ? ' workspace-library' : '')}><aside className="sidebar">
    <a href="?page=library" className="wordmark" onClick={event => { event.preventDefault(); navigate('library'); }}>MusicFS</a>
    <Menu aria-label={t("主导航")} mode="inline" selectedKeys={[page]} onClick={({ key }) => navigate(key as typeof page)} items={[
      { key: 'library', icon: <FolderOutlined aria-hidden="true" />, label: <>{t("音乐库")}{draft && <span className="unsaved-dot" aria-label={t("有未保存的目录修改")} />}</> },
      { key: 'connection', icon: <LinkOutlined aria-hidden="true" />, label: t("连接与挂载") },
      { type: 'divider' }, { key: 'plugins', icon: <AppstoreOutlined aria-hidden="true" />, label: t("插件") },
      { key: 'settings', icon: <SettingOutlined aria-hidden="true" />, label: t("设置") }
    ]} />
    <div className="library-sidebar-slot" ref={setLibrarySidebar} hidden={page !== 'library'} />
    <footer className="sidebar-footer"><Badge status={status.isSuccess ? 'success' : status.isError ? 'error' : 'processing'} text={status.isSuccess ? status.data.host === 'desktop' ? t("MusicFS 后台") : t("云端服务") : status.isError ? t("连接失败") : t("正在连接")} />
      <div className="version">{status.data?.version}</div>
      <LanguageSwitch />
      <Dropdown trigger={['click']} menu={{ items: [
        ...(status.data?.host === 'desktop' ? [{ key: 'phone', label: t("手机访问"), onClick: () => setPhoneOpen(true) }] : []),
        { key: 'logout', label: t("退出登录"), onClick: disconnect },
        ...(status.data?.host === 'desktop' ? [{ key: 'quit', label: t("退出 MusicFS"), disabled: quit.isPending, onClick: () => quit.mutate() }] : [])
      ] }}><Button type="text" icon={<MoreOutlined />} aria-label={t("服务操作")}>{t("服务操作")}</Button></Dropdown>
    </footer>
  </aside><Layout className="main-layout"><main className={'main-content' + (page === 'library' ? ' music-main' : '')}>{page !== 'library' && <header className="page-heading"><Typography.Title level={1}>{titles[page]}</Typography.Title>{serviceControl}</header>}
    <Failure error={quit.error} /><Failure error={logoutError} />
    {quitFailed && <Alert className="feedback" showIcon closable onClose={() => setQuitFailed(false)} type="warning" title={t("退出未完成，请先关闭正在使用挂载文件的程序，再重试。")} />}
    {status.isError && <Alert showIcon type="error" title={t("无法连接 MusicFS")} description={messageText(status.error)} action={<Button onClick={() => void status.refetch()}>{t("重试")}</Button>} />}
    {status.isPending ? <Skeleton active /> : status.isSuccess && <ErrorBoundary resetKeys={[page]} fallbackRender={() => <Alert type="error" showIcon title={t("页面未能加载")} action={<Button onClick={() => location.reload()}>{t("重新打开")}</Button>} />}><Suspense fallback={<Skeleton active />}>
      <Activity mode={page === 'library' ? 'visible' : 'hidden'}><MusicWorkspace api={api} sidebar={librarySidebar} serviceControl={serviceControl} showPlugins={continueAdding => { setAddAfterInstall(!!continueAdding); setInstallRequested(true); navigate('plugins'); }} showConnection={() => navigate('connection')} initialPluginId={newPlugin} consumePlugin={() => setNewPlugin(null)} draft={draft} setDraft={setDraft} /></Activity>
      {page === 'plugins' && <Plugins api={api} addSource={addSource} startInstalling={installRequested} addAfterInstall={addAfterInstall} consumeInstall={() => { setInstallRequested(false); setAddAfterInstall(false); }} />}
      {page === 'connection' && <Connection api={api} tab={connectionTab} setTab={setConnectionTab} />}
      {page === 'settings' && <Settings api={api} desktop={status.data.host === 'desktop'} />}
    </Suspense></ErrorBoundary>}</main></Layout>
    {phoneOpen && status.data?.host === 'desktop' && <PhoneAccess api={api} onClose={closePhone} openSettings={() => { closePhone(); navigate('settings'); }} />}
  </Layout>;
}
