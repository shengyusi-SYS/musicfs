import { useState } from 'react';
import { Alert, App, Button, Collapse, Dropdown, Empty, Form, Input, Modal, Radio, Skeleton, Space, Tag, Typography } from 'antd';
import { MoreOutlined, PlusOutlined, FolderOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type Api } from '../api';
import type { MountCacheSettings, MountInput, MountView } from '../../contracts/mounts';
import { Failure } from '../components/feedback';
import { CacheSummary, MountCacheFields } from '../components/cache-settings';

const labels: Record<MountView['state'], string> = { starting: '正在挂载', mounted: '已挂载', unmounting: '正在卸载', stopped: '已卸载', error: '挂载失败' };
type Fields = { name?: string; mountPoint?: string; directoryCacheSeconds: number; fileCacheMaxMiB: number; fileCacheMaxAgeHours: number; url?: string; username?: string; password?: string };

export default function Mounts({ api }: { api: Api }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const [open, setOpen] = useState(false); const [kind, setKind] = useState<'local' | 'remote'>('local'); const [form] = Form.useForm<Fields>();
  const [mountError, setMountError] = useState('');
  const [cacheTarget, setCacheTarget] = useState<MountView | null>(null); const [cacheForm] = Form.useForm<MountCacheSettings>();
  const [cacheError, setCacheError] = useState('');
  const cacheStatus = useQuery({ queryKey: ['mount-cache', cacheTarget?.id],
    queryFn: ({ signal }) => api.mountCacheStatus(cacheTarget!.id, signal), enabled: cacheTarget !== null,
    refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false });
  const prerequisites = useQuery({ queryKey: ['mount-prerequisites'], queryFn: ({ signal }) => api.mountPrerequisites(signal),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2 });
  const install = useMutation({ mutationFn: () => api.installWinFsp(), onSuccess: value => {
    client.setQueryData(['mount-prerequisites'], value);
    if (value.state === 'ready') message.success('挂载组件已就绪，可继续挂载');
  }, onError: () => { void prerequisites.refetch(); } });
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: ({ signal }) => api.mounts(signal),
    refetchInterval: query => {
      const items = query.state.data ?? [];
      if (items.some(item => ['starting', 'unmounting'].includes(item.state))) return 3000;
      return items.some(item => item.state === 'mounted') ? 15000 : false;
    } });
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
  const clearCache = useMutation({ mutationFn: (id: string) => api.clearMountCache(id), onSuccess: async result => {
    setCacheTarget(result);
    await Promise.all([client.invalidateQueries({ queryKey: ['mounts'] }), client.invalidateQueries({ queryKey: ['mount-cache', result.id] })]);
    if (result.state === 'error') { setCacheError(result.error?.message ?? '缓存已清理，重新挂载未完成，请检查后重试。'); return; }
    setCacheError(''); message.success(result.state === 'mounted' ? '读取缓存已清理并重新挂载' : '读取缓存已清理');
  }, onError: () => { void client.invalidateQueries({ queryKey: ['mounts'] }); } });
  const refresh = useMutation({ mutationFn: (id: string) => api.refreshMount(id), onSuccess: () => {
    message.success('已清除挂载目录缓存，下次打开目录时重新读取');
  } });
  const changing = mount.isPending || unmount.isPending || remount.isPending || remove.isPending || install.isPending || configureCache.isPending || clearCache.isPending || refresh.isPending;
  async function submit(values: Fields) {
    setMountError('');
    const source: MountInput['source'] = kind === 'local' ? { kind: 'local' } : { kind: 'remote', url: values.url!, username: values.username!, password: values.password! };
    await mount.mutateAsync({ mountPoint: values.mountPoint?.trim() || (prerequisites.data?.kind === 'winfsp' ? '*' : ''), source, directoryCacheSeconds: values.directoryCacheSeconds,
      fileCacheMaxMiB: values.fileCacheMaxMiB, fileCacheMaxAgeHours: values.fileCacheMaxAgeHours,
      ...(values.name?.trim() ? { name: values.name.trim() } : {}) });
  }
  if (mounts.error instanceof ApiError && mounts.error.status === 404) return <Empty description="请从桌面程序打开本机挂载" />;
  function editCache(item: MountView) {
    configureCache.reset(); clearCache.reset(); setCacheError(''); setCacheTarget(item);
    cacheForm.setFieldsValue({ directoryCacheSeconds: item.directoryCacheSeconds, fileCacheMaxMiB: item.fileCacheMaxMiB, fileCacheMaxAgeHours: item.fileCacheMaxAgeHours });
  }
  return <><div className="page-actions"><Typography.Text type="secondary">像本地文件一样，在播放器中打开音乐</Typography.Text>
    <Button type="primary" icon={<PlusOutlined aria-hidden="true" />} disabled={!mounts.isSuccess || changing} onClick={() => { mount.reset(); setMountError(''); setOpen(true); }}>添加挂载</Button></div>
    {prerequisites.data?.kind === 'winfsp' && prerequisites.data.state !== 'ready' && <Alert className="feedback" showIcon type="info" title="首次挂载需要安装 WinFsp" action={prerequisites.data.canInstall
      ? <Button loading={install.isPending} disabled={changing && !install.isPending} onClick={() => install.mutate()}>安装挂载组件</Button>
      : <Button loading={prerequisites.isFetching} onClick={() => void prerequisites.refetch()}>重新检测</Button>} />}
    {prerequisites.error && !(prerequisites.error instanceof ApiError && prerequisites.error.status === 404) && <Failure error={prerequisites.error} retry={() => void prerequisites.refetch()} />}
    <Failure error={install.error} /><Failure error={mounts.error} retry={() => void mounts.refetch()} /><Failure error={unmount.error} /><Failure error={remount.error} /><Failure error={remove.error} /><Failure error={refresh.error} />
    <section className="surface mount-list">{mounts.isPending ? <div className="loading-surface"><Skeleton active /></div> : !mounts.isError && !mounts.data?.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="给音乐一个盘符，或挂载到文件夹" /> : mounts.data?.map(item => <article className="mount-row" key={item.id}>
      <div className="source-avatar"><FolderOutlined aria-hidden="true" /></div><div className="instance-identity"><Typography.Text strong>{item.name}</Typography.Text><div className="mount-location">{item.mountPoint}</div><div className="secondary-id">{item.source.kind === 'local' ? '本机音乐目录' : item.source.url}</div>
        {item.error && <div role="alert" className="inline-error">{item.error.message}</div>}</div>
      <div className="instance-actions"><Tag color={item.state === 'mounted' ? 'success' : item.state === 'error' ? 'error' : 'default'}>{labels[item.state]}</Tag>
        {item.state === 'mounted' ? <Button loading={unmount.isPending && unmount.variables === item.id} disabled={changing} onClick={() => unmount.mutate(item.id)}>卸载</Button>
          : <Button loading={remount.isPending && remount.variables === item.id} disabled={changing || ['starting', 'unmounting'].includes(item.state)} onClick={() => remount.mutate(item.id)}>挂载</Button>}
        <Dropdown trigger={['click']} menu={{ items: [
          { key: 'remount', label: '重新挂载', disabled: changing, onClick: () => remount.mutate(item.id) },
          { key: 'refresh', label: '刷新目录缓存', disabled: changing || item.state !== 'mounted', onClick: () => refresh.mutate(item.id) },
          { key: 'cache', label: '缓存设置', disabled: changing, onClick: () => editCache(item) },
          { type: 'divider' }, { key: 'remove', label: '移除挂载', danger: true, disabled: changing, onClick: () => remove.mutate(item.id) }
        ] }}><Button type="text" icon={<MoreOutlined aria-hidden="true" />} aria-label={item.name + '的更多操作'} /></Dropdown>
      </div></article>)}</section>
    <Modal title="添加挂载" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden>
      <Form form={form} layout="vertical" onFinish={submit} preserve={false} initialValues={{ directoryCacheSeconds: 300, fileCacheMaxMiB: 8192, fileCacheMaxAgeHours: 168 }}>
        <Form.Item label="音乐目录"><Radio.Group value={kind} onChange={event => setKind(event.target.value)} options={[{ label: '本机 MusicFS', value: 'local' }, { label: '远程 WebDAV', value: 'remote' }]} disabled={mount.isPending} /></Form.Item>
        {kind === 'remote' && <><Form.Item label="WebDAV 地址" name="url" rules={[{ required: true, type: 'url', message: '请输入完整 WebDAV 地址' }]}><Input placeholder="https://music.example.com/dav" /></Form.Item>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}><Input autoComplete="off" /></Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}><Input.Password autoComplete="off" /></Form.Item></>}
        <Form.Item label={prerequisites.data?.kind === 'winfsp' ? '盘符或挂载目录（可选）' : '挂载目录'} name="mountPoint"
          extra={prerequisites.data?.kind === 'winfsp' ? '留空时自动分配盘符。' : undefined}
          rules={prerequisites.data?.kind === 'winfsp' ? [] : [{ required: true, whitespace: true, message: '请输入挂载目录' }]}>
          <Input placeholder={prerequisites.data?.kind === 'winfsp' ? 'M:，或留空自动选择' : '/home/me/MusicFS'} />
        </Form.Item>
        <Collapse ghost items={[{ key: 'options', label: '更多设置', forceRender: true, children: <><Form.Item label="名称" name="name"><Input maxLength={120} placeholder="可选" /></Form.Item><MountCacheFields /></> }]} />
        <Failure error={mount.error} />{mountError && <Alert className="feedback" type="error" showIcon title={mountError} />}
        <Button type="primary" htmlType="submit" block loading={mount.isPending}>挂载</Button>
      </Form>
    </Modal>
    <Modal title={cacheTarget?.name + ' · 缓存设置'} open={cacheTarget !== null} onCancel={() => setCacheTarget(null)} footer={null} destroyOnHidden>
      <Failure error={cacheStatus.error} retry={() => void cacheStatus.refetch()} />
      {cacheStatus.data && <CacheSummary value={cacheStatus.data} />}
      {cacheStatus.data?.actualMode && cacheStatus.data.actualMode !== cacheStatus.data.configuredMode && <Alert className="feedback" type="warning" showIcon title="重新挂载后，缓存设置才会生效" />}
      <Form form={cacheForm} layout="vertical" preserve={false} onFinish={settings => { if (cacheTarget) { setCacheError(''); configureCache.mutate({ id: cacheTarget.id, settings }); } }}>
        <MountCacheFields />
        {cacheTarget?.state === 'mounted' && <p className="muted-note">保存或清理缓存时会重新挂载。</p>}
        <Failure error={configureCache.error} /><Failure error={clearCache.error} />{cacheError && <Alert className="feedback" type="error" showIcon title={cacheError} />}
        <div className="dialog-actions"><Space><Button danger loading={clearCache.isPending} disabled={!cacheStatus.data || changing} onClick={() => { if (cacheTarget) clearCache.mutate(cacheTarget.id); }}>清理缓存</Button>
          <Button loading={cacheStatus.isFetching} onClick={() => void cacheStatus.refetch()}>刷新统计</Button></Space><Button type="primary" htmlType="submit" loading={configureCache.isPending} disabled={changing}>保存</Button></div>
      </Form>
    </Modal>
  </>;
}
