import { lazy, Suspense } from 'react';
import { Alert, App, Button, Modal, QRCode, Result, Skeleton, Space, Typography } from 'antd';
import { ErrorBoundary } from 'react-error-boundary';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthenticationAction, AuthenticationSession, SourceInstance } from '../../contracts/management';
import type { Api } from '../api';
import { ApiError } from '../api';
import { Failure } from './feedback';

const SchemaForm = lazy(() => import('./schema-form'));
const keyOf = (id: string) => ['authentication', id];
const pollKey = (id: string) => ['authentication-poll', id];
async function perform(api: Api, id: string, action: AuthenticationAction, signal?: AbortSignal) {
  const outcome = await api.authenticate(id, action, signal);
  if (!outcome.ok) throw new ApiError(422, { error: outcome.error });
  return outcome.value;
}

export default function Authentication({ api, instance, close }: { api: Api; instance: SourceInstance; close: () => void }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const session = useQuery({ queryKey: keyOf(instance.id), queryFn: ({ signal }) => api.authentication(instance.id, signal) });
  const action = useMutation({ mutationFn: (value: AuthenticationAction) => perform(api, instance.id, value),
    onMutate: async () => { await client.cancelQueries({ queryKey: pollKey(instance.id) }); await client.cancelQueries({ queryKey: keyOf(instance.id) }); },
    onSuccess: async value => {
      client.setQueryData(keyOf(instance.id), value);
      await client.invalidateQueries({ queryKey: ['instances'] }); await client.invalidateQueries({ queryKey: ['roots', instance.id] });
      await client.invalidateQueries({ queryKey: ['library'] });
      if (value.step?.kind === 'complete') message.success('来源授权已保存');
    }
  });
  const current = session.data; const step = current?.step;
  const active = current && (!step || step.kind === 'waiting' || step.kind === 'input');
  return <Modal open title={`${instance.name} · 来源授权`} onCancel={close} footer={null} width={560} destroyOnHidden>
    <Typography.Paragraph type="secondary">授权由来源插件处理，凭据只保存在此实例中。关闭窗口后可以重新打开，继续尚未过期的步骤。</Typography.Paragraph>
    <Failure error={session.error} retry={() => void session.refetch()} /><Failure error={action.error} />
    {session.isPending ? <Skeleton active /> : <>
      {(!current || !step) && <Alert type="info" showIcon title={current ? '授权准备尚未完成，可重新开始。' : '尚未开始来源授权。'} />}
      {step?.kind === 'waiting' && current && <Waiting api={api} instance={instance} session={current} paused={action.isPending} reload={() => void session.refetch()} />}
      {step?.kind === 'input' && current && <div className="auth-input"><Typography.Paragraph>{step.message}</Typography.Paragraph>
        <Typography.Paragraph type="secondary">此步骤有效至 {new Date(step.expiresAt).toLocaleString()}</Typography.Paragraph>
        {current.error && !action.error && <Alert showIcon type="error" title={current.error.message} />}
        <ErrorBoundary key={step.challengeId} fallbackRender={() => <Alert type="error" showIcon title="无法显示此来源的授权表单，请重新开始或联系插件作者。" />}><Suspense fallback={<Skeleton active />}>
          <SchemaForm configuration={step.configuration} value={{}} pending={action.isPending} error={action.error} submitLabel="提交授权信息"
            onSubmit={input => action.mutate({ kind: 'submit', operationId: current.operationId, challengeId: step.challengeId, input })} />
        </Suspense></ErrorBoundary>
      </div>}
      {step?.kind === 'complete' && <Result status="success" title="授权已完成" subTitle={step.accountName ? `来源账号：${step.accountName}` : '来源返回的授权状态已保存。'} />}
      {step?.kind === 'expired' && <Result status="warning" title="授权已过期" subTitle={step.message} />}
      {step?.kind === 'cancelled' && <Result status="info" title="本次授权已取消" />}
      <Space wrap className="auth-actions"><Button disabled={action.isPending || session.isError} loading={action.isPending && action.variables?.kind === 'start'} type={active ? 'default' : 'primary'} onClick={() => action.mutate({ kind: 'start' })}>{current ? '重新开始授权' : '开始授权'}</Button>
        {active && <Button danger disabled={action.isPending} loading={action.isPending && action.variables?.kind === 'cancel'} onClick={() => action.mutate({ kind: 'cancel', operationId: current.operationId })}>取消本次授权</Button>}
      </Space>
    </>}
  </Modal>;
}

function Waiting({ api, instance, session, paused, reload }: { api: Api; instance: SourceInstance; session: AuthenticationSession; paused: boolean; reload: () => void }) {
  const client = useQueryClient(); const step = session.step;
  const challenge = step?.kind === 'waiting' ? step.challengeId : '';
  const poll = useQuery({ queryKey: [...pollKey(instance.id), session.operationId, challenge], enabled: !paused && !!challenge,
    queryFn: async ({ signal }) => {
      const value = await perform(api, instance.id, { kind: 'poll', operationId: session.operationId, challengeId: challenge }, signal);
      signal.throwIfAborted();
      client.setQueryData<AuthenticationSession | null>(keyOf(instance.id), previous => previous?.operationId === session.operationId && previous.step?.kind === 'waiting' && previous.step.challengeId === challenge ? value : previous);
      if (value.step?.kind === 'complete') {
        await client.invalidateQueries({ queryKey: ['instances'] }); await client.invalidateQueries({ queryKey: ['roots', instance.id] });
        await client.invalidateQueries({ queryKey: ['library'] });
      }
      return value;
    }, retry: false, refetchInterval: query => query.state.error || query.state.data?.step?.kind !== 'waiting' ? false : 3000
  });
  if (step?.kind !== 'waiting') return null;
  return <div className="auth-waiting"><Typography.Paragraph>{step.message}</Typography.Paragraph>
    {step.qrImage ? <img className="auth-qr-image" src={step.qrImage} alt="来源授权二维码" /> : step.qrCode && <ErrorBoundary fallbackRender={() => <Alert type="error" title="二维码暂时无法显示，请使用授权链接或重新开始。" />}><QRCode value={step.qrCode} size={208} /></ErrorBoundary>}
    {step.url && <Typography.Paragraph><a href={step.url} target="_blank" rel="noreferrer noopener">在新窗口打开授权页面</a></Typography.Paragraph>}
    <Typography.Paragraph type="secondary">有效至 {new Date(step.expiresAt).toLocaleString()} · 自动检查授权结果</Typography.Paragraph>
    <Failure error={poll.error} retry={() => { if (poll.error instanceof ApiError && poll.error.status === 409) reload(); else void poll.refetch(); }} />
  </div>;
}
