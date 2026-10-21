import { useState } from 'react';
import { Alert, App, Button, Form, Input, InputNumber, Modal, Radio, Space, Table, Tag, Typography } from 'antd';
import { PlusOutlined, PoweroffOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type Api } from '../api';
import type { MountCacheSettings, MountInput, MountView } from '../../contracts/mounts';
import { Failure } from '../components/feedback';

const labels: Record<MountView['state'], string> = { starting: '正在挂载', mounted: '已挂载', unmounting: '正在卸载', stopped: '已卸载', error: '挂载失败' };
type Fields = { name?: string; mountPoint: string; directoryCacheSeconds: number; fileCacheMaxMiB: number; fileCacheMaxAgeHours: number;
  url?: string; username?: string; password?: string };
function MountCacheFields() {
  return <><Form.Item label="目录缓存（秒）" name="directoryCacheSeconds"
    extra="默认 300 秒。0 表示不自动过期；只影响目录清单。"
    rules={[{ required: true, type: 'integer', min: 0, max: 2_147_483_647, message: '请输入非负整数秒数' }]}>
    <InputNumber min={0} max={2_147_483_647} precision={0} style={{ width: '100%' }} />
  </Form.Item>
    <Typography.Paragraph type="secondary">读取缓存只保留按需读取的音频片段，重复打开时可以复用，不预先下载整曲。</Typography.Paragraph>
    <Form.Item label="读取缓存容量（MiB）" name="fileCacheMaxMiB"
      extra="默认 8192 MiB（8 GiB），为每个挂载的软上限。0 表示关闭读取缓存；关闭不会清理已存片段。"
      rules={[{ required: true, type: 'integer', min: 0, max: 1_048_576, message: '请输入 0 至 1048576 的整数' }]}>
      <InputNumber min={0} max={1_048_576} precision={0} style={{ width: '100%' }} />
    </Form.Item>
    <Form.Item label="未访问缓存保留时间（小时）" name="fileCacheMaxAgeHours"
      extra="默认 168 小时（7 天），按未访问时长淘汰。0 表示不按时间淘汰。"
      rules={[{ required: true, type: 'integer', min: 0, max: 2_147_483, message: '请输入 0 至 2147483 的整数' }]}>
      <InputNumber min={0} max={2_147_483} precision={0} style={{ width: '100%' }} />
    </Form.Item></>;
}
export default function Mounts({ api, onStopped }: { api: Api; onStopped: () => void }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const [open, setOpen] = useState(false); const [kind, setKind] = useState<'local' | 'remote'>('local'); const [form] = Form.useForm<Fields>();
  const [mountError, setMountError] = useState('');
  const [cacheTarget, setCacheTarget] = useState<MountView | null>(null); const [cacheForm] = Form.useForm<MountCacheSettings>();
  const [cacheError, setCacheError] = useState('');
  const prerequisites = useQuery({ queryKey: ['mount-prerequisites'], queryFn: ({ signal }) => api.mountPrerequisites(signal),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2 });
  const install = useMutation({ mutationFn: () => api.installWinFsp(), onSuccess: value => {
    client.setQueryData(['mount-prerequisites'], value);
    if (value.state === 'ready') message.success('挂载组件已就绪，可继续挂载');
  }, onError: () => { void prerequisites.refetch(); } });
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: ({ signal }) => api.mounts(signal),
    refetchInterval: query => query.state.data?.some(item => ['starting', 'mounted', 'unmounting'].includes(item.state)) ? 3000 : false });
  const mount = useMutation({ mutationFn: (input: MountInput) => api.mount(input), onSuccess: async result => {
    await client.invalidateQueries({ queryKey: ['mounts'] });
    if (result.state !== 'mounted') { setMountError(result.error?.message ?? '挂载尚未就绪，请检查状态后重试。'); return; }
    setOpen(false); form.resetFields(); message.success('挂载已就绪');
  }, onError: () => { void client.invalidateQueries({ queryKey: ['mounts'] }); } });
  const unmount = useMutation({ mutationFn: (id: string) => api.unmount(id), onSuccess: async () => {
    await client.invalidateQueries({ queryKey: ['mounts'] }); message.success('已正常卸载');
  }, onError: () => { void client.invalidateQueries({ queryKey: ['mounts'] }); } });
  const remount = useMutation({ mutationFn: (id: string) => api.remount(id), onSuccess: async result => {
    await client.invalidateQueries({ queryKey: ['mounts'] });
    if (result.state === 'mounted') message.success('已重新挂载');
  }, onError: () => { void client.invalidateQueries({ queryKey: ['mounts'] }); } });
  const remove = useMutation({ mutationFn: (id: string) => api.removeMount(id), onSuccess: async () => {
    await client.invalidateQueries({ queryKey: ['mounts'] }); message.success('挂载项已移除');
  }, onError: () => { void client.invalidateQueries({ queryKey: ['mounts'] }); } });
  const configureCache = useMutation({ mutationFn: ({ id, settings }: { id: string; settings: MountCacheSettings }) => api.configureMountCache(id, settings), onSuccess: async result => {
    await client.invalidateQueries({ queryKey: ['mounts'] });
    if (result.state === 'error') { setCacheError(result.error?.message ?? '设置已保存，重新挂载未完成，请检查后重试。'); return; }
    setCacheTarget(null); message.success(result.state === 'mounted' ? '挂载缓存设置已保存并重新挂载' : '挂载缓存设置已保存');
  }, onError: () => { void client.invalidateQueries({ queryKey: ['mounts'] }); } });
  const refresh = useMutation({ mutationFn: (id: string) => api.refreshMount(id), onSuccess: () => {
    message.success('已清除挂载目录缓存，下次打开目录时重新读取');
  } });
  const quit = useMutation({ mutationFn: () => api.quitDesktop(), onSuccess: async () => {
    await client.cancelQueries(); onStopped();
  } });
  const changing = mount.isPending || unmount.isPending || remount.isPending || remove.isPending || quit.isPending || install.isPending || configureCache.isPending || refresh.isPending;
  async function submit(values: Fields) {
    setMountError('');
    const source: MountInput['source'] = kind === 'local' ? { kind: 'local' } : { kind: 'remote', url: values.url!, username: values.username!, password: values.password! };
    await mount.mutateAsync({ mountPoint: values.mountPoint, source, directoryCacheSeconds: values.directoryCacheSeconds,
      fileCacheMaxMiB: values.fileCacheMaxMiB, fileCacheMaxAgeHours: values.fileCacheMaxAgeHours,
      ...(values.name?.trim() ? { name: values.name.trim() } : {}) });
  }
  if (mounts.error && 'status' in mounts.error && mounts.error.status === 404) return <Alert type="info" showIcon title="从桌面启动器打开即可管理挂载" description="当前开发服务只提供 WebDAV 连接。桌面发行程序会管理随包 rclone 和本机挂载。" />;
  return <section className="surface"><div className="page-actions"><Typography.Title level={3}>本机挂载</Typography.Title>
    <Button type="primary" icon={<PlusOutlined />} disabled={!mounts.isSuccess || changing} onClick={() => { mount.reset(); setMountError(''); setOpen(true); }}>添加挂载</Button></div>
    <Typography.Paragraph type="secondary">将本机音乐目录或远程 WebDAV 挂载到盘符或目录。关闭网页后，后台与挂载继续运行。</Typography.Paragraph>
    {prerequisites.data?.kind === 'winfsp' && <Alert showIcon type={prerequisites.data.state === 'ready' ? 'success' : 'warning'}
      title={prerequisites.data.state === 'ready' ? `Windows 挂载组件已就绪${prerequisites.data.version ? ` · ${prerequisites.data.version}` : ''}` : '首次挂载需要 WinFsp 组件'}
      description={<><Typography.Paragraph>{prerequisites.data.message}</Typography.Paragraph><Space wrap>
        {prerequisites.data.state !== 'ready' && prerequisites.data.canInstall && <Button type="primary" loading={install.isPending} disabled={changing && !install.isPending} onClick={() => install.mutate()}>安装挂载组件</Button>}
        <Button loading={prerequisites.isFetching} disabled={changing} onClick={() => void prerequisites.refetch()}>重新检测</Button>
      </Space></>} />}
    {prerequisites.error && !(prerequisites.error instanceof ApiError && prerequisites.error.status === 404) && <Failure error={prerequisites.error} retry={() => void prerequisites.refetch()} />}
    <Failure error={install.error} />
    <Typography.Paragraph type="secondary">“卸载”保留连接以便再次挂载；“移除”会断开挂载并删除保存的连接配置。“刷新挂载目录”只清除挂载端清单，不刷新音乐平台内容；本机 MusicFS 发布新目录时也会自动清除对应缓存。</Typography.Paragraph>
    <Failure error={mounts.error} retry={() => void mounts.refetch()} /><Failure error={unmount.error} /><Failure error={remount.error} /><Failure error={remove.error} /><Failure error={refresh.error} />
    <Table rowKey="id" loading={mounts.isPending} dataSource={mounts.data} pagination={false} locale={{ emptyText: '尚无挂载，添加一个本机或远程连接即可开始。' }} columns={[
      { title: '名称 / 位置', key: 'name', render: (_, item) => <><Typography.Text strong>{item.name}</Typography.Text><div>{item.mountPoint}</div>
        <Typography.Text type="secondary">目录缓存：{item.directoryCacheSeconds === 0 ? '手动刷新' : `${item.directoryCacheSeconds ?? 300} 秒`}</Typography.Text>
        <div><Typography.Text type="secondary">读取缓存：{(item.fileCacheMaxMiB ?? 8192) === 0 ? '已关闭' : `${item.fileCacheMaxMiB ?? 8192} MiB`}</Typography.Text></div></> },
      { title: '来源', key: 'source', render: (_, item) => item.source.kind === 'local' ? '本机 MusicFS' : item.source.url },
      { title: '状态', key: 'state', render: (_, item) => <><Tag color={item.state === 'mounted' ? 'success' : item.state === 'error' ? 'error' : 'default'}>{labels[item.state]}</Tag>{item.error && <div role="alert">{item.error.message}</div>}</> },
      { title: '操作', key: 'action', render: (_, item) => <Space wrap>
        <Button loading={remount.isPending && remount.variables === item.id} disabled={changing || ['starting', 'unmounting'].includes(item.state)} onClick={() => remount.mutate(item.id)}>重新挂载</Button>
        {['mounted', 'starting', 'unmounting', 'error'].includes(item.state) && <Button loading={unmount.isPending && unmount.variables === item.id} disabled={changing} onClick={() => unmount.mutate(item.id)}>卸载</Button>}
        <Button disabled={changing} onClick={() => { configureCache.reset(); setCacheError(''); setCacheTarget(item); cacheForm.setFieldsValue({
          directoryCacheSeconds: item.directoryCacheSeconds ?? 300, fileCacheMaxMiB: item.fileCacheMaxMiB ?? 8192,
          fileCacheMaxAgeHours: item.fileCacheMaxAgeHours ?? 168 }); }}>缓存设置</Button>
        <Button loading={refresh.isPending && refresh.variables === item.id} disabled={changing || item.state !== 'mounted'} onClick={() => refresh.mutate(item.id)}>刷新挂载目录</Button>
        <Button danger loading={remove.isPending && remove.variables === item.id} disabled={changing} onClick={() => remove.mutate(item.id)}>移除</Button>
      </Space> }
    ]} />
    <div className="page-actions"><Typography.Text type="secondary">退出时会先正常卸载；文件仍被占用时，后台会保留运行并提示原因。</Typography.Text>
      <Button icon={<PoweroffOutlined />} loading={quit.isPending} disabled={!mounts.isSuccess || changing} onClick={() => quit.mutate()}>退出 MusicFS 后台</Button></div>
    <Failure error={quit.error} />
    <Modal title="添加挂载" open={open} onCancel={() => { if (!mount.isPending) setOpen(false); }} footer={null} destroyOnHidden closable={!mount.isPending} mask={{ closable: !mount.isPending }}>
      <Form form={form} layout="vertical" onFinish={submit} preserve={false} initialValues={{ directoryCacheSeconds: 300, fileCacheMaxMiB: 8192, fileCacheMaxAgeHours: 168 }}>
        <Form.Item label="来源"><Radio.Group value={kind} onChange={event => setKind(event.target.value)} options={[{ label: '本机 MusicFS', value: 'local' }, { label: '远程 WebDAV', value: 'remote' }]} disabled={mount.isPending} /></Form.Item>
        <Form.Item label="名称（可选）" name="name"><Input maxLength={120} /></Form.Item>
        <Form.Item label="盘符或挂载目录" name="mountPoint" rules={[{ required: true, whitespace: true, message: '请输入本机挂载位置' }]}><Input placeholder="例如 M: 或 /home/me/MusicFS" /></Form.Item>
        <MountCacheFields />
        {kind === 'remote' && <><Form.Item label="WebDAV 地址" name="url" rules={[{ required: true, type: 'url', message: '请输入完整 WebDAV 地址' }]}><Input placeholder="https://music.example.com/dav" /></Form.Item>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入读取用户名' }]}><Input autoComplete="off" /></Form.Item>
          <Form.Item label="读取密码" name="password" rules={[{ required: true, message: '请输入读取密码' }]}><Input.Password autoComplete="off" /></Form.Item></>}
        <Failure error={mount.error} />{mountError && <Alert type="error" showIcon title={mountError} />}<Space><Button type="primary" htmlType="submit" loading={mount.isPending}>挂载</Button><Button disabled={mount.isPending} onClick={() => setOpen(false)}>取消</Button></Space>
      </Form>
    </Modal>
    <Modal title={`挂载缓存设置${cacheTarget ? ` · ${cacheTarget.name}` : ''}`} open={cacheTarget !== null}
      onCancel={() => { if (!configureCache.isPending) setCacheTarget(null); }} footer={null} destroyOnHidden closable={!configureCache.isPending} mask={{ closable: !configureCache.isPending }}>
      <Typography.Paragraph>已挂载的连接会在保存后正常卸载并重新挂载；文件占用导致卸载失败时，保留原设置和挂载。已卸载的连接只保存设置。</Typography.Paragraph>
      <Form form={cacheForm} layout="vertical" preserve={false} onFinish={settings => {
        if (cacheTarget) { setCacheError(''); configureCache.mutate({ id: cacheTarget.id, settings }); }
      }}>
        <MountCacheFields />
        <Failure error={configureCache.error} />{cacheError && <Alert type="error" showIcon title={cacheError} />}
        <Space><Button type="primary" htmlType="submit" loading={configureCache.isPending}>保存</Button><Button disabled={configureCache.isPending} onClick={() => setCacheTarget(null)}>取消</Button></Space>
      </Form>
    </Modal>
  </section>;
}
