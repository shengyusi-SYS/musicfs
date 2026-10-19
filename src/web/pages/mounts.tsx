import { useState } from 'react';
import { Alert, App, Button, Form, Input, Modal, Radio, Space, Table, Tag, Typography } from 'antd';
import { PlusOutlined, PoweroffOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Api } from '../api';
import type { MountInput, MountView } from '../../contracts/mounts';
import { Failure } from '../components/feedback';

const labels: Record<MountView['state'], string> = { starting: '正在挂载', mounted: '已挂载', unmounting: '正在卸载', stopped: '已卸载', error: '挂载失败' };
type Fields = { name?: string; mountPoint: string; url?: string; username?: string; password?: string };
export default function Mounts({ api, onStopped }: { api: Api; onStopped: () => void }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const [open, setOpen] = useState(false); const [kind, setKind] = useState<'local' | 'remote'>('local'); const [form] = Form.useForm<Fields>();
  const [mountError, setMountError] = useState('');
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
  const quit = useMutation({ mutationFn: () => api.quitDesktop(), onSuccess: async () => {
    await client.cancelQueries(); onStopped();
  } });
  async function submit(values: Fields) {
    setMountError('');
    const source: MountInput['source'] = kind === 'local' ? { kind: 'local' } : { kind: 'remote', url: values.url!, username: values.username!, password: values.password! };
    await mount.mutateAsync({ mountPoint: values.mountPoint, source, ...(values.name?.trim() ? { name: values.name.trim() } : {}) });
  }
  if (mounts.error && 'status' in mounts.error && mounts.error.status === 404) return <Alert type="info" showIcon title="从桌面启动器打开即可管理挂载" description="当前开发服务只提供 WebDAV 连接。桌面发行程序会管理随包 rclone 和本机挂载。" />;
  return <section className="surface"><div className="page-actions"><Typography.Title level={3}>本机挂载</Typography.Title>
    <Button type="primary" icon={<PlusOutlined />} disabled={!mounts.isSuccess} onClick={() => { mount.reset(); setMountError(''); setOpen(true); }}>添加挂载</Button></div>
    <Typography.Paragraph type="secondary">将本机音乐目录或远程 WebDAV 挂载到盘符或目录。关闭网页后，后台与挂载继续运行。</Typography.Paragraph>
    <Failure error={mounts.error} retry={() => void mounts.refetch()} /><Failure error={unmount.error} />
    <Table rowKey="id" loading={mounts.isPending} dataSource={mounts.data} pagination={false} locale={{ emptyText: '尚无挂载，添加一个本机或远程连接即可开始。' }} columns={[
      { title: '名称 / 位置', key: 'name', render: (_, item) => <><Typography.Text strong>{item.name}</Typography.Text><div>{item.mountPoint}</div></> },
      { title: '来源', key: 'source', render: (_, item) => item.source.kind === 'local' ? '本机 MusicFS' : item.source.url },
      { title: '状态', key: 'state', render: (_, item) => <><Tag color={item.state === 'mounted' ? 'success' : item.state === 'error' ? 'error' : 'default'}>{labels[item.state]}</Tag>{item.error && <div role="alert">{item.error.message}</div>}</> },
      { title: '操作', key: 'action', render: (_, item) => ['mounted', 'starting', 'unmounting', 'error'].includes(item.state) && <Button loading={unmount.isPending && unmount.variables === item.id} disabled={item.state === 'unmounting'} onClick={() => unmount.mutate(item.id)}>卸载</Button> }
    ]} />
    <div className="page-actions"><Typography.Text type="secondary">退出时会先正常卸载；文件仍被占用时，后台会保留运行并提示原因。</Typography.Text>
      <Button icon={<PoweroffOutlined />} loading={quit.isPending} disabled={!mounts.isSuccess || mount.isPending || unmount.isPending} onClick={() => quit.mutate()}>退出 MusicFS 后台</Button></div>
    <Failure error={quit.error} />
    <Modal title="添加挂载" open={open} onCancel={() => { if (!mount.isPending) setOpen(false); }} footer={null} destroyOnHidden closable={!mount.isPending} mask={{ closable: !mount.isPending }}>
      <Form form={form} layout="vertical" onFinish={submit} preserve={false}>
        <Form.Item label="来源"><Radio.Group value={kind} onChange={event => setKind(event.target.value)} options={[{ label: '本机 MusicFS', value: 'local' }, { label: '远程 WebDAV', value: 'remote' }]} disabled={mount.isPending} /></Form.Item>
        <Form.Item label="名称（可选）" name="name"><Input maxLength={120} /></Form.Item>
        <Form.Item label="盘符或挂载目录" name="mountPoint" rules={[{ required: true, whitespace: true, message: '请输入本机挂载位置' }]}><Input placeholder="例如 M: 或 /home/me/MusicFS" /></Form.Item>
        {kind === 'remote' && <><Form.Item label="WebDAV 地址" name="url" rules={[{ required: true, type: 'url', message: '请输入完整 WebDAV 地址' }]}><Input placeholder="https://music.example.com/dav" /></Form.Item>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入读取用户名' }]}><Input autoComplete="off" /></Form.Item>
          <Form.Item label="读取密码" name="password" rules={[{ required: true, message: '请输入读取密码' }]}><Input.Password autoComplete="off" /></Form.Item></>}
        <Failure error={mount.error} />{mountError && <Alert type="error" showIcon title={mountError} />}<Space><Button type="primary" htmlType="submit" loading={mount.isPending}>挂载</Button><Button disabled={mount.isPending} onClick={() => setOpen(false)}>取消</Button></Space>
      </Form>
    </Modal>
  </section>;
}
