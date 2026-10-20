import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Progress, Space, Typography } from 'antd';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RefreshScope, RefreshView } from '../../contracts/refreshes';
import { ApiError, type Api } from '../api';
import { Failure } from './feedback';

export const pendingRefreshId = (error: Error | null | undefined) => error instanceof ApiError ? error.refreshOperationId : undefined;
const active = (value: RefreshView | null | undefined) => value?.status === 'queued' || value?.status === 'running';

function newer(previous: RefreshView | null | undefined, next: RefreshView): RefreshView {
  if (!previous) return next;
  if (previous.operationId !== next.operationId) return Date.parse(previous.createdAt) > Date.parse(next.createdAt) ? previous : next;
  if (!active(previous) && active(next)) return previous;
  return Date.parse(previous.updatedAt) > Date.parse(next.updatedAt) ? previous : next;
}

/** Pure GETs restore persistent state; a separate serial mutation advances one page. */
export function usePersistentRefresh(api: Api, input: {
  instanceId?: string | undefined;
  operationId?: string | undefined;
  onCompleted?: ((view: RefreshView) => void) | undefined;
}) {
  const client = useQueryClient();
  const owner = input.instanceId ?? input.operationId ?? '';
  const [selected, setSelected] = useState<{ owner: string; id: string; pendingId: string | undefined } | null>(null);
  const callback = useRef(input.onCompleted); callback.current = input.onCompleted;
  const watched = useRef(new Set<string>());
  const pendingNotice = useRef<{ owner: string; id: string } | null>(null);
  const pacing = useRef({ operationId: '', delay: 150 });
  const current = useQuery({ queryKey: ['refresh-current', input.instanceId], enabled: !!input.instanceId,
    queryFn: ({ signal }) => api.currentRefresh(input.instanceId!, signal), retry: false });
  const selectedId = selected?.owner === owner ? selected.id : undefined;
  const operationId = selectedId ?? input.operationId ?? current.data?.operationId;
  useEffect(() => {
    const id = input.operationId;
    if (!id || pendingNotice.current?.owner === owner && pendingNotice.current.id === id) return;
    pendingNotice.current = { owner, id };
    // The first GET may already be terminal when the host finished a cold read.
    watched.current.add(id);
    setSelected(previous => previous?.owner === owner && previous.pendingId === id ? previous : { owner, id, pendingId: id });
  }, [owner, input.operationId]);
  const operation = useQuery({ queryKey: ['refresh', operationId], enabled: !!operationId,
    queryFn: async ({ signal }) => {
      const next = await api.refreshOperation(operationId!, signal);
      return newer(client.getQueryData<RefreshView>(['refresh', operationId]), next);
    }, retry: false,
    initialData: () => current.data?.operationId === operationId ? current.data ?? undefined : undefined,
    refetchInterval: query => active(query.state.data) ? 2_000 : false });
  const view = operation.data ?? (current.data?.operationId === operationId ? current.data : undefined);
  const accept = (next: RefreshView) => {
    client.setQueryData<RefreshView>(['refresh', next.operationId], previous => newer(previous, next));
    client.setQueryData<RefreshView | null>(['refresh-current', next.instanceId], previous => newer(previous, next));
  };
  const start = useMutation({ mutationFn: (request: { instanceId: string; scope: RefreshScope }) => api.startRefresh(request.instanceId, request.scope),
    onSuccess: value => {
      pacing.current = { operationId: value.operationId, delay: 150 }; accept(value); watched.current.add(value.operationId);
      setSelected({ owner: value.instanceId, id: value.operationId, pendingId: input.operationId });
    } });
  const step = useMutation({ mutationKey: ['refresh-step', operationId], scope: { id: `refresh:${operationId ?? 'none'}` },
    mutationFn: (id: string) => api.stepRefresh(id), onSuccess: next => {
      const previous = client.getQueryData<RefreshView>(['refresh', next.operationId]);
      const unchanged = previous?.operationId === next.operationId && previous.status === next.status && previous.updatedAt === next.updatedAt
        && previous.current?.kind === next.current?.kind && previous.current?.directoryRef === next.current?.directoryRef
        && previous.current?.pages === next.current?.pages && previous.current?.entries === next.current?.entries;
      pacing.current = { operationId: next.operationId, delay: unchanged ? 2_000 : 150 };
      accept(next);
    } });
  const stepping = useIsMutating({ mutationKey: ['refresh-step', operationId] });
  const cancel = useMutation({ mutationFn: (id: string) => api.cancelRefresh(id), onSuccess: accept });
  const running = active(view);
  useEffect(() => {
    if (!operationId || !running || step.isPending || stepping || step.error || operation.error || cancel.isPending) return;
    const retryDelay = view?.retryAt ? Math.max(0, Date.parse(view.retryAt) - Date.now()) : 0;
    const timer = setTimeout(() => step.mutate(operationId), Math.max(retryDelay, pacing.current.operationId === operationId ? pacing.current.delay : 150));
    return () => clearTimeout(timer);
  }, [operationId, running, step.isPending, step.error, operation.error, stepping, cancel.isPending, view?.updatedAt, view?.retryAt]);
  useEffect(() => {
    if (!view) return;
    if (active(view)) { watched.current.add(view.operationId); return; }
    if (!watched.current.delete(view.operationId)) return;
    if (view.status === 'failed') {
      void client.invalidateQueries({ queryKey: ['directory-status', view.instanceId] });
      return;
    }
    if (view.status !== 'completed') return;
    void Promise.all([
      client.invalidateQueries({ queryKey: ['roots', view.instanceId] }),
      client.invalidateQueries({ queryKey: ['library'] }),
      client.invalidateQueries({ queryKey: ['directory-status', view.instanceId] })
    ]);
    callback.current?.(view);
  }, [client, view]);
  return {
    view, active: running, preparing: !!operationId && !view, starting: start.isPending, cancelling: cancel.isPending,
    error: start.error ?? step.error ?? cancel.error ?? operation.error ?? current.error,
    start(scope: RefreshScope) {
      if (!input.instanceId) return;
      step.reset(); cancel.reset(); start.mutate({ instanceId: input.instanceId, scope });
    },
    cancel() { if (operationId) cancel.mutate(operationId); },
    retry() {
      step.reset(); cancel.reset(); start.reset();
      if (operationId) void operation.refetch(); else void current.refetch();
    }
  };
}

export function RefreshProgress({ operation, labels, reload, reauthorize }: {
  operation: ReturnType<typeof usePersistentRefresh>;
  labels?: Record<string, string> | undefined;
  reload?: (() => void) | undefined;
  reauthorize?: (() => void) | undefined;
}) {
  const value = operation.view;
  const needsAuth = value?.error?.sourceFault?.kind === 'needs_auth' || value?.failures.some(item => item.error.sourceFault?.kind === 'needs_auth');
  const waiting = operation.active && value?.retryAt && Date.parse(value.retryAt) > Date.now();
  const progress = value?.current?.progress;
  const title = !value ? '正在读取刷新状态' : waiting ? '来源要求等待，稍后自动继续' : value.status === 'queued' ? '目录已加入准备队列'
    : value.status === 'running' ? '正在准备目录' : value.status === 'completed' ? (value.failures.length ? '刷新完成，部分目录保留上次内容' : '目录刷新完成')
      : value.status === 'cancelled' ? '刷新已取消' : value.status === 'superseded' ? '刷新已被较新的操作替代' : '刷新失败，已保留上次成功内容';
  return <>
    {(value || operation.starting || operation.preparing) && <Alert className="feedback" showIcon
      type={value?.status === 'failed' ? 'error' : value?.failures.length ? 'warning' : value?.status === 'completed' ? 'success' : 'info'}
      title={operation.starting ? '正在提交刷新' : title}
      description={value && <>
        <div>{value.status === 'completed' && value.scope.kind === 'directory' && value.scope.directoryRef === undefined
          ? '内容入口已更新' : <>已完成 {value.refreshedDirectories} 个目录</>}</div>
        {value.current && value.status !== 'completed' && <div>当前{value.current.kind === 'roots' ? '内容入口' : '目录'}已读取 {value.current.pages} 页，暂存 {value.current.entries} 条目</div>}
        {progress && <div>已处理 {progress.completed.toLocaleString()} / {progress.total.toLocaleString()} {progress.unit}
          <Progress size="small" percent={progress.total ? Math.floor(progress.completed / progress.total * 100) : 100} status={waiting ? 'normal' : operation.active ? 'active' : 'normal'} />
        </div>}
        {waiting && <div>预计 {new Date(value.retryAt!).toLocaleTimeString()} 继续，可关闭页面。</div>}
        {value.current?.statistics && value.status !== 'completed' && <Space wrap>{Object.entries(labels ?? {}).flatMap(([key, label]) => {
          const count = value.current?.statistics?.[key]; return count === undefined ? [] : [<Typography.Text key={key}>临时{label}：{count}</Typography.Text>];
        })}</Space>}
        {value.error && <div role="alert">{value.error.message}</div>}
        {value.failures.length > 0 && <div role="alert">{value.failures.length} 个目录失败：{[...new Set(value.failures.map(item => item.error.message))].join('；')}</div>}
      </>}
      action={operation.active ? <Button size="small" loading={operation.cancelling} onClick={operation.cancel}>取消刷新</Button>
        : needsAuth && reauthorize ? <Button size="small" onClick={reauthorize}>重新授权</Button>
        : value && value.status !== 'completed' && reload ? <Button size="small" loading={operation.starting} onClick={reload}>重新读取目录</Button> : undefined} />}
    <Failure error={operation.error} retry={operation.retry} reauthorize={reauthorize} />
  </>;
}
