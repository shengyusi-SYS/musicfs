import { App, Button, Form, Input, Skeleton, Switch, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DesktopPreferences } from '../../contracts/desktop';
import type { Api } from '../api';
import DesktopNetwork from '../components/desktop-network';
import { Failure } from '../components/feedback';

export default function Settings({ api, desktop }: { api: Api; desktop: boolean }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const access = useQuery({ queryKey: ['access'], queryFn: () => api.access() });
  const [form] = Form.useForm<{ username: string; password: string }>();
  const account = useMutation({ mutationFn: (values: { username: string; password: string }) => api.saveAccount(values.username.trim(), values.password),
    onSuccess: value => { client.setQueryData(['access'], value); form.setFieldValue('password', ''); message.success('登录账号已保存'); } });
  return <div className="settings-sections"><section className="surface"><div className="section-heading"><Typography.Title level={3}>登录账号</Typography.Title></div>
    <Failure error={access.error} retry={() => void access.refetch()} />
    {access.isPending ? <Skeleton active /> : <Form form={form} className="account-form" layout="vertical" initialValues={{ username: access.data?.passwordConfigured ? access.data.username : 'admin' }} onFinish={values => account.mutate(values)}>
      <Form.Item label="用户名" name="username" rules={[{ required: true, whitespace: true, message: '请输入用户名' }, { max: 64 }]}><Input autoComplete="username" maxLength={64} /></Form.Item>
      <Form.Item label={access.data?.passwordConfigured ? '新密码' : '密码'} name="password" rules={[{ required: true, message: '请输入密码' }, { min: 8, max: 128, message: '密码须为 8—128 个字符' }]}><Input.Password autoComplete="new-password" /></Form.Item>
      <Failure error={account.error} /><Button type="primary" htmlType="submit" loading={account.isPending}>{access.data?.passwordConfigured ? '保存账号与密码' : '设置登录账号'}</Button>
    </Form>}
  </section>{desktop && <><DesktopStartup api={api} /><section className="surface"><div className="section-heading"><Typography.Title level={3}>局域网访问</Typography.Title></div><DesktopNetwork api={api} /></section></>}</div>;
}

function DesktopStartup({ api }: { api: Api }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const preferences = useQuery({ queryKey: ['desktop-preferences'], queryFn: ({ signal }) => api.desktopPreferences(signal) });
  const save = useMutation({ mutationFn: (settings: DesktopPreferences) => api.saveDesktopPreferences(settings), onSuccess: value => {
    client.setQueryData(['desktop-preferences'], value); message.success('设置已保存');
  } });
  const rows: { key: keyof DesktopPreferences; label: string }[] = [
    { key: 'launchAtLogin', label: '登录系统后启动 MusicFS' },
    { key: 'openOnLaunch', label: '手动启动时打开管理页面' },
    { key: 'openOnLogin', label: '登录系统自启时打开管理页面' },
    { key: 'autoMount', label: '启动时恢复自动挂载' },
    { key: 'retryAutoMount', label: '挂载暂时失败后自动重试' }
  ];
  return <section className="surface"><div className="section-heading"><Typography.Title level={3}>启动与挂载</Typography.Title></div>
    <Failure error={preferences.error} retry={() => void preferences.refetch()} /><Failure error={save.error} />
    {preferences.data?.integration.error && <Typography.Paragraph type="secondary">{preferences.data.integration.error}</Typography.Paragraph>}
    {preferences.isPending ? <Skeleton active /> : preferences.data && rows.map(row => <div className="setting-row" key={row.key}>
      <label htmlFor={'preference-' + row.key}>{row.label}</label><Switch id={'preference-' + row.key} checked={preferences.data.settings[row.key]} loading={save.isPending && save.variables?.[row.key] !== preferences.data.settings[row.key]}
        disabled={save.isPending || row.key === 'retryAutoMount' && !preferences.data.settings.autoMount}
        onChange={value => save.mutate({ ...preferences.data.settings, [row.key]: value })} />
    </div>)}
  </section>;
}
