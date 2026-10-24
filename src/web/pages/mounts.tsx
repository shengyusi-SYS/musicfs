import { t, messageText } from '../i18n';
import { useState } from 'react';
import { Alert, App, Button, Collapse, Dropdown, Empty, Form, Input, Modal, Radio, Skeleton, Space, Switch, Tag, Typography } from 'antd';
import { MoreOutlined, PlusOutlined, FolderOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type Api } from '../api';
import { CACHE_YEAR_HOURS, MOUNT_FILE_CACHE_MIB, directoryCacheDefault } from '../../contracts/cache-defaults';
import type { MountCacheSettings, MountInput, MountView } from '../../contracts/mounts';
import type { DisplayMessage } from '@musicfs/plugin-api';
import { Failure } from '../components/feedback';
import { CacheSummary, MountCacheFields } from '../components/cache-settings';

const labels: Record<MountView['state'], string> = { get starting() { return t("正在挂载"); }, get mounted() { return t("已挂载"); }, get unmounting() { return t("正在卸载"); }, get stopped() { return t("已卸载"); }, get error() { return t("挂载失败"); } };
type Fields = { name?: string; mountPoint?: string; autoMount: boolean; directoryCacheSeconds: number; fileCacheMaxMiB: number; fileCacheMaxAgeHours: number; url?: string; username?: string; password?: string };

export default function Mounts({ api }: { api: Api }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const [open, setOpen] = useState(false); const [kind, setKind] = useState<'local' | 'remote'>('local'); const [form] = Form.useForm<Fields>();
  const [mountError, setMountError] = useState<string | DisplayMessage>('');
  const [renameTarget, setRenameTarget] = useState<MountView | null>(null); const [renameForm] = Form.useForm<{ name: string }>();
  const [cacheTarget, setCacheTarget] = useState<MountView | null>(null); const [cacheForm] = Form.useForm<MountCacheSettings>();
  const [cacheError, setCacheError] = useState<string | DisplayMessage>('');
  const cacheStatus = useQuery({ queryKey: ['mount-cache', cacheTarget?.id],
    queryFn: ({ signal }) => api.mountCacheStatus(cacheTarget!.id, signal), enabled: cacheTarget !== null,
    refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false });
  const prerequisites = useQuery({ queryKey: ['mount-prerequisites'], queryFn: ({ signal }) => api.mountPrerequisites(signal),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2 });
  const network = useQuery({ queryKey: ['desktop-network'], queryFn: ({ signal }) => api.desktopNetwork(signal) });
  const machine = network.data?.machine;
  const systemName = machine && ({ win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[machine.platform] ?? machine.platform);
  const mountLocation = machine ? t("挂载位置：{{value0}} · {{value1}}", { value0: machine.name, value1: systemName }) : t("挂载到运行 MusicFS 的设备");
  const install = useMutation({ mutationFn: () => api.installWinFsp(), onSuccess: value => {
    client.setQueryData(['mount-prerequisites'], value);
    if (value.state === 'ready') message.success(t("挂载组件已就绪，可继续挂载"));
  }, onError: () => { void prerequisites.refetch(); } });
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: ({ signal }) => api.mounts(signal),
    refetchInterval: query => {
      const items = query.state.data ?? [];
      if (items.some(item => ['starting', 'unmounting'].includes(item.state))) return 3000;
      return items.some(item => item.state === 'mounted') ? 15000 : false;
    } });
  const mount = useMutation({ mutationFn: (input: MountInput) => api.mount(input), onSuccess: async result => {
    await client.invalidateQueries({ queryKey: ['mounts'] });
    if (result.state !== 'mounted') { setMountError(result.error ?? t("挂载尚未就绪，请检查状态后重试。")); return; }
    setOpen(false); form.resetFields(); message.success(t("挂载已就绪"));
  }, onError: () => { void client.invalidateQueries({ queryKey: ['mounts'] }); } });
  const unmount = useMutation({ mutationFn: (id: string) => api.unmount(id), onSuccess: async () => {
    await client.invalidateQueries({ queryKey: ['mounts'] }); message.success(t("已正常卸载"));
  }, onError: () => { void client.invalidateQueries({ queryKey: ['mounts'] }); } });
  const remount = useMutation({ mutationFn: (id: string) => api.remount(id), onSuccess: async result => {
    await client.invalidateQueries({ queryKey: ['mounts'] });
    if (result.state === 'mounted') message.success(t("已重新挂载"));
  }, onError: () => { void client.invalidateQueries({ queryKey: ['mounts'] }); } });
  const remove = useMutation({ mutationFn: (id: string) => api.removeMount(id), onSuccess: async () => {
    await client.invalidateQueries({ queryKey: ['mounts'] }); message.success(t("挂载项已移除"));
  }, onError: () => { void client.invalidateQueries({ queryKey: ['mounts'] }); } });
  const autoMount = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.configureMountAutoMount(id, enabled),
    onSuccess: () => client.invalidateQueries({ queryKey: ['mounts'] }) });
  const rename = useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => api.renameMount(id, name), onSuccess: async result => {
    await client.invalidateQueries({ queryKey: ['mounts'] });
    if (result.state === 'error') { message.error(t("名称已保存，重新挂载未完成，请查看挂载状态")); return; }
    setRenameTarget(null); message.success(t("名称已更新"));
  }, onError: () => { void client.invalidateQueries({ queryKey: ['mounts'] }); } });
  const configureCache = useMutation({ mutationFn: ({ id, settings }: { id: string; settings: MountCacheSettings }) => api.configureMountCache(id, settings), onSuccess: async result => {
    await client.invalidateQueries({ queryKey: ['mounts'] });
    if (result.state === 'error') { setCacheError(result.error ?? t("设置已保存，重新挂载未完成，请检查后重试。")); return; }
    setCacheTarget(null); message.success(result.state === 'mounted' ? t("挂载缓存设置已保存并重新挂载") : t("挂载缓存设置已保存"));
  }, onError: () => { void client.invalidateQueries({ queryKey: ['mounts'] }); } });
  const clearCache = useMutation({ mutationFn: (id: string) => api.clearMountCache(id), onSuccess: async result => {
    setCacheTarget(result);
    await Promise.all([client.invalidateQueries({ queryKey: ['mounts'] }), client.invalidateQueries({ queryKey: ['mount-cache', result.id] })]);
    if (result.state === 'error') { setCacheError(result.error ?? t("缓存已清理，重新挂载未完成，请检查后重试。")); return; }
    setCacheError(''); message.success(result.state === 'mounted' ? t("读取缓存已清理并重新挂载") : t("读取缓存已清理"));
  }, onError: () => { void client.invalidateQueries({ queryKey: ['mounts'] }); } });
  const refresh = useMutation({ mutationFn: (id: string) => api.refreshMount(id), onSuccess: () => {
    message.success(t("已清除挂载目录缓存，下次打开目录时重新读取"));
  } });
  const changing = mount.isPending || unmount.isPending || remount.isPending || remove.isPending || install.isPending || configureCache.isPending || clearCache.isPending || refresh.isPending || rename.isPending;
  async function submit(values: Fields) {
    setMountError('');
    const source: MountInput['source'] = kind === 'local' ? { kind: 'local' } : { kind: 'remote', url: values.url!, username: values.username!, password: values.password! };
    await mount.mutateAsync({ mountPoint: values.mountPoint?.trim() || (prerequisites.data?.kind === 'winfsp' ? '*' : ''), source, directoryCacheSeconds: values.directoryCacheSeconds,
      fileCacheMaxMiB: values.fileCacheMaxMiB, fileCacheMaxAgeHours: values.fileCacheMaxAgeHours, autoMount: values.autoMount,
      ...(values.name?.trim() ? { name: values.name.trim() } : {}) });
  }
  if (mounts.error instanceof ApiError && mounts.error.status === 404) return <Empty description={t("请从桌面程序打开本机挂载")} />;
  function editCache(item: MountView) {
    configureCache.reset(); clearCache.reset(); setCacheError(''); setCacheTarget(item);
    cacheForm.setFieldsValue({ directoryCacheSeconds: item.directoryCacheSeconds, fileCacheMaxMiB: item.fileCacheMaxMiB, fileCacheMaxAgeHours: item.fileCacheMaxAgeHours });
  }
  return <><div className="page-actions"><Typography.Text type="secondary">{mountLocation}</Typography.Text>
    <Button type="primary" icon={<PlusOutlined aria-hidden="true" />} disabled={!mounts.isSuccess || changing} onClick={() => { mount.reset(); setMountError(''); setOpen(true); }}>{t("添加挂载")}</Button></div>
    {prerequisites.data?.kind === 'winfsp' && prerequisites.data.state !== 'ready' && <Alert className="feedback" showIcon type="info" title={t("首次挂载需要安装 WinFsp")} action={prerequisites.data.canInstall
      ? <Button loading={install.isPending} disabled={changing && !install.isPending} onClick={() => install.mutate()}>{t("安装挂载组件")}</Button>
      : <Button loading={prerequisites.isFetching} onClick={() => void prerequisites.refetch()}>{t("重新检测")}</Button>} />}
    {prerequisites.error && !(prerequisites.error instanceof ApiError && prerequisites.error.status === 404) && <Failure error={prerequisites.error} retry={() => void prerequisites.refetch()} />}
    <Failure error={install.error} /><Failure error={mounts.error} retry={() => void mounts.refetch()} /><Failure error={unmount.error} /><Failure error={remount.error} /><Failure error={remove.error} /><Failure error={refresh.error} /><Failure error={autoMount.error} />
    <section className="surface mount-list">{mounts.isPending ? <div className="loading-surface"><Skeleton active /></div> : !mounts.isError && !mounts.data?.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("给音乐一个盘符，或挂载到文件夹")} /> : mounts.data?.map(item => <article className="mount-row" key={item.id}>
      <div className="source-avatar"><FolderOutlined aria-hidden="true" /></div><div className="instance-identity"><Typography.Text strong>{item.name}</Typography.Text><div className="mount-location">{item.mountPoint}</div><div className="secondary-id">{item.source.kind === 'local' ? t("当前 MusicFS 音乐目录") : item.source.url}</div>
        {item.error && <div role="alert" className="inline-error">{messageText(item.error)}</div>}</div>
      <div className="instance-actions"><Tag color={item.state === 'mounted' ? 'success' : item.state === 'error' ? 'error' : 'default'}>{labels[item.state]}</Tag>
        <label className="mount-auto"><Switch size="small" checked={item.autoMount} disabled={changing || autoMount.isPending} onChange={enabled => autoMount.mutate({ id: item.id, enabled })} />{t("自动挂载")}</label>
        {item.state === 'mounted' ? <Button loading={unmount.isPending && unmount.variables === item.id} disabled={changing} onClick={() => unmount.mutate(item.id)}>{t("卸载")}</Button>
          : <Button loading={remount.isPending && remount.variables === item.id} disabled={changing || ['starting', 'unmounting'].includes(item.state)} onClick={() => remount.mutate(item.id)}>{t("挂载")}</Button>}
        <Dropdown trigger={['click']} menu={{ items: [
          { key: 'rename', label: t("重命名"), disabled: changing, onClick: () => { rename.reset(); setRenameTarget(item); renameForm.setFieldsValue({ name: item.name }); } },
          { key: 'remount', label: t("重新挂载"), disabled: changing, onClick: () => remount.mutate(item.id) },
          { key: 'refresh', label: t("刷新目录缓存"), disabled: changing || item.state !== 'mounted', onClick: () => refresh.mutate(item.id) },
          { key: 'cache', label: t("缓存设置"), disabled: changing, onClick: () => editCache(item) },
          { type: 'divider' }, { key: 'remove', label: t("移除挂载"), danger: true, disabled: changing, onClick: () => remove.mutate(item.id) }
        ] }}><Button type="text" icon={<MoreOutlined aria-hidden="true" />} aria-label={item.name + t("的更多操作")} /></Dropdown>
      </div></article>)}</section>
    <Modal title={t("添加挂载")} open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden>
      <Typography.Paragraph type="secondary">{mountLocation}</Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={submit} preserve={false} initialValues={{ directoryCacheSeconds: directoryCacheDefault(kind), fileCacheMaxMiB: MOUNT_FILE_CACHE_MIB, fileCacheMaxAgeHours: CACHE_YEAR_HOURS, autoMount: true }}>
        <Form.Item label={t("音乐目录")}><Radio.Group value={kind} onChange={event => {
          const next = event.target.value as 'local' | 'remote';
          if (form.getFieldValue('directoryCacheSeconds') === directoryCacheDefault(kind)) form.setFieldValue('directoryCacheSeconds', directoryCacheDefault(next));
          setKind(next);
        }} options={[{ label: t("当前 MusicFS"), value: 'local' }, { label: t("其他 WebDAV"), value: 'remote' }]} disabled={mount.isPending} /></Form.Item>
        {kind === 'remote' && <><Form.Item label={t("WebDAV 地址")} name="url" rules={[{ required: true, type: 'url', message: t("请输入完整 WebDAV 地址") }]}><Input placeholder="https://music.example.com/dav" /></Form.Item>
          <Form.Item label={t("用户名")} name="username" rules={[{ required: true, message: t("请输入用户名") }]}><Input autoComplete="off" /></Form.Item>
          <Form.Item label={t("密码")} name="password" rules={[{ required: true, message: t("请输入密码") }]}><Input.Password autoComplete="off" /></Form.Item></>}
        <Form.Item label={t("名称（可选）")} name="name"><Input maxLength={120} placeholder="MusicFS" /></Form.Item>
        <Form.Item label={prerequisites.data?.kind === 'winfsp' ? t("盘符或挂载目录（可选）") : t("挂载目录")} name="mountPoint"
          extra={prerequisites.data?.kind === 'winfsp' ? t("留空时自动分配盘符。") : undefined}
          rules={prerequisites.data?.kind === 'winfsp' ? [] : [{ required: true, whitespace: true, message: t("请输入挂载目录") }]}>
          <Input placeholder={prerequisites.data?.kind === 'winfsp' ? 'M:' : '/home/me/MusicFS'} />
        </Form.Item>
        <Collapse ghost items={[{ key: 'options', label: t("更多设置"), forceRender: true, children: <><Form.Item label={t("启动时自动挂载")} name="autoMount" valuePropName="checked"><Switch /></Form.Item><MountCacheFields /></> }]} />
        <Failure error={mount.error} />{mountError && <Alert className="feedback" type="error" showIcon title={messageText(mountError)} />}
        <Button type="primary" htmlType="submit" block loading={mount.isPending}>{t("挂载")}</Button>
      </Form>
    </Modal>
    <Modal title={t("重命名挂载")} open={renameTarget !== null} onCancel={() => setRenameTarget(null)} footer={null} destroyOnHidden>
      <Form form={renameForm} layout="vertical" preserve={false} onFinish={({ name }) => { if (renameTarget) rename.mutate({ id: renameTarget.id, name }); }}>
        <Form.Item label={t("名称")} name="name" rules={[{ required: true, whitespace: true, message: t("请输入名称") }, { max: 120 }]}><Input maxLength={120} autoFocus /></Form.Item>
        <Failure error={rename.error} /><Button type="primary" htmlType="submit" loading={rename.isPending} block>{renameTarget?.state === 'mounted' ? t("保存并重新挂载") : t("保存")}</Button>
      </Form>
    </Modal>
    <Modal title={cacheTarget?.name + t(" · 缓存设置")} open={cacheTarget !== null} onCancel={() => setCacheTarget(null)} footer={null} destroyOnHidden>
      <Failure error={cacheStatus.error} retry={() => void cacheStatus.refetch()} />
      {cacheStatus.data && <CacheSummary value={cacheStatus.data} />}
      {cacheStatus.data?.actualMode && cacheStatus.data.actualMode !== cacheStatus.data.configuredMode && <Alert className="feedback" type="warning" showIcon title={t("重新挂载后，缓存设置才会生效")} />}
      <Form form={cacheForm} layout="vertical" preserve={false} onFinish={settings => { if (cacheTarget) { setCacheError(''); configureCache.mutate({ id: cacheTarget.id, settings }); } }}>
        <MountCacheFields />
        {cacheTarget?.state === 'mounted' && <p className="muted-note">{t("保存或清理缓存时会重新挂载。")}</p>}
        <Failure error={configureCache.error} /><Failure error={clearCache.error} />{cacheError && <Alert className="feedback" type="error" showIcon title={messageText(cacheError)} />}
        <div className="dialog-actions"><Space><Button danger loading={clearCache.isPending} disabled={!cacheStatus.data || changing} onClick={() => { if (cacheTarget) clearCache.mutate(cacheTarget.id); }}>{t("清理缓存")}</Button>
          <Button loading={cacheStatus.isFetching} onClick={() => void cacheStatus.refetch()}>{t("刷新统计")}</Button></Space><Button type="primary" htmlType="submit" loading={configureCache.isPending} disabled={changing}>{t("保存")}</Button></div>
      </Form>
    </Modal>
  </>;
}
