import { t, messageText } from '../i18n';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
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

export default function Authentication({ api, instance, close, done, needsReauthorization = false }: { api: Api; instance: SourceInstance; close: () => void; done?: () => void; needsReauthorization?: boolean }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const started = useRef(false);
  const [currentFlowReady, setCurrentFlowReady] = useState(!needsReauthorization);
  const session = useQuery({ queryKey: keyOf(instance.id), queryFn: ({ signal }) => api.authentication(instance.id, signal) });
  useQuery({ queryKey: ['configuration', instance.pluginId], queryFn: ({ signal }) => api.configuration(instance.pluginId, signal) });
  const action = useMutation({ mutationFn: (value: AuthenticationAction) => perform(api, instance.id, value),
    onMutate: async () => { await client.cancelQueries({ queryKey: pollKey(instance.id) }); await client.cancelQueries({ queryKey: keyOf(instance.id) }); },
    onSuccess: async (value, requested) => {
      if (requested.kind === 'start') setCurrentFlowReady(true);
      client.setQueryData(keyOf(instance.id), value);
      await client.invalidateQueries({ queryKey: ['instances'] }); await client.invalidateQueries({ queryKey: ['roots', instance.id] });
      await client.invalidateQueries({ queryKey: ['library'] });
      await client.invalidateQueries({ queryKey: ['directory-status', instance.id] });
      if (value.step?.kind === 'complete') message.success(t("登录完成"));
      if (requested.kind === 'cancel') close();
    }
  });
  const current = session.data; const step = current?.step;
  const active = current && (!step || step.kind === 'waiting' || step.kind === 'input');
  const start = action.mutate;
  useEffect(() => {
    if (!session.isSuccess || started.current) return;
    started.current = true;
    if (!session.data?.step || needsReauthorization && session.data.step.kind !== 'waiting' && session.data.step.kind !== 'input') start({ kind: 'start' });
    else if (session.data.step.kind === 'waiting' || session.data.step.kind === 'input') setCurrentFlowReady(true);
  }, [session.isSuccess, session.data, needsReauthorization, start]);
  const showReauthorization = needsReauthorization && !currentFlowReady;
  return <Modal open title={t('登录 {{name}}', { name: instance.name })} onCancel={close} footer={null} width={480} destroyOnHidden>
    <Failure error={session.error} retry={() => void session.refetch()} /><Failure error={action.error} />
    {session.isPending ? <Skeleton active /> : <>
      {(!current || !step || action.isPending && action.variables?.kind === 'start') && <Skeleton active paragraph={{ rows: 2 }} />}
      {step?.kind === 'waiting' && current && <Waiting api={api} instance={instance} session={current} paused={action.isPending} reload={() => void session.refetch()} />}
      {step?.kind === 'input' && current && <div className="auth-input"><Typography.Paragraph>{t(step.message)}</Typography.Paragraph>
        {current.error && !action.error && <Alert showIcon type="error" title={messageText(current.error)} />}
        <ErrorBoundary key={step.challengeId} fallbackRender={() => <Alert type="error" showIcon title={t("登录表单未能加载，请重试。")} />}><Suspense fallback={<Skeleton active />}>
          <SchemaForm configuration={step.configuration} value={{}} pending={action.isPending} error={action.error} submitLabel={t("提交授权信息")}
            onSubmit={input => action.mutate({ kind: 'submit', operationId: current.operationId, challengeId: step.challengeId, input })} />
        </Suspense></ErrorBoundary>
      </div>}
      {step?.kind === 'complete' && !showReauthorization && !action.isPending && <Result status="success" title={t("登录完成")} subTitle={step.accountName}
        extra={<Button type="primary" onClick={done ?? close}>{t("浏览内容")}</Button>} />}
      {step?.kind === 'expired' && <Result status="warning" title={t("登录步骤已过期")} subTitle={t(step.message)} />}
      {step?.kind === 'cancelled' && <Result status="info" title={t("登录已取消")} />}
      <Space wrap className="auth-actions"><Button disabled={action.isPending || session.isError} loading={action.isPending && action.variables?.kind === 'start'} type={active || step?.kind === 'complete' ? 'text' : 'primary'} onClick={() => action.mutate({ kind: 'start' })}>{step?.kind === 'waiting' && (step.qrCode || step.qrImage) ? t("刷新二维码") : t("重新登录")}</Button>
        {active && <Button type="text" disabled={action.isPending} loading={action.isPending && action.variables?.kind === 'cancel'} onClick={() => action.mutate({ kind: 'cancel', operationId: current.operationId })}>{t("取消登录")}</Button>}
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
        await client.invalidateQueries({ queryKey: ['directory-status', instance.id] });
      }
      return value;
    }, retry: false, refetchInterval: query => query.state.error || query.state.data?.step?.kind !== 'waiting' ? false : 3000
  });
  if (step?.kind !== 'waiting') return null;
  return <div className="auth-waiting"><Typography.Paragraph>{t(step.message)}</Typography.Paragraph>
    {step.qrImage ? <img className="auth-qr-image" src={step.qrImage} alt={t("来源授权二维码")} /> : step.qrCode && <ErrorBoundary fallbackRender={() => <Alert type="error" title={t("二维码未能显示，请重新登录。")} />}><QRCode value={step.qrCode} size={208} /></ErrorBoundary>}
    {step.url && <Typography.Paragraph><a href={step.url} target="_blank" rel="noreferrer noopener">{t("在新窗口打开授权页面")}</a></Typography.Paragraph>}
    <Failure error={poll.error} retry={() => { if (poll.error instanceof ApiError && poll.error.status === 409) reload(); else void poll.refetch(); }} />
  </div>;
}
