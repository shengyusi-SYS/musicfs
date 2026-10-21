import { App, Button, Empty, Skeleton, Space, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { SourceInstance } from '../../contracts/management';
import type { Api } from '../api';
import { Failure } from './feedback';
import { pendingRefreshId, RefreshProgress, usePersistentRefresh } from './refresh';
import { RefreshPolicyControl } from './refresh-policy';

export function SourceContent({ api, instance, reauthorize, showLibrary }: {
  api: Api; instance: SourceInstance; reauthorize?: (() => void) | undefined; showLibrary: () => void;
}) {
  const { message } = App.useApp();
  const roots = useQuery({ queryKey: ['roots', instance.id, instance.epoch], queryFn: ({ signal }) => api.roots(instance.id, signal) });
  const pending = pendingRefreshId(roots.error);
  const configuration = useQuery({ queryKey: ['configuration', instance.pluginId], queryFn: ({ signal }) => api.configuration(instance.pluginId, signal) });
  const statuses = useQueries({ queries: (roots.data ?? []).map(root => ({ queryKey: ['directory-status', instance.id, instance.epoch, root.directoryRef],
    queryFn: ({ signal }: { signal: AbortSignal }) => api.directoryStatus(instance.id, root.directoryRef, signal) })) });
  const refresh = usePersistentRefresh(api, { instanceId: instance.id, operationId: pending, onCompleted: result => {
    if (result.failures.length) message.warning('部分目录更新失败，可稍后重试');
    else message.success(result.scope.kind === 'file-info' ? '文件已准备' : '内容已更新');
  } });
  const busy = refresh.active || refresh.starting || refresh.preparing || roots.isFetching;
  return <><div className="page-actions"><Button onClick={showLibrary}>查看音乐目录</Button><Button icon={<ReloadOutlined aria-hidden="true" />} loading={refresh.starting || refresh.active && refresh.view?.scope.kind === 'instance'} disabled={busy} onClick={() => refresh.start({ kind: 'instance' })}>更新全部内容</Button></div>
    <Failure error={pending ? null : roots.error} retry={() => void roots.refetch()} reauthorize={reauthorize} /><Failure error={configuration.error} />
    <RefreshProgress operation={refresh} labels={configuration.data?.statistics} reload={() => refresh.view && refresh.start(refresh.view.scope)} reauthorize={reauthorize} />
    {roots.isPending ? <Skeleton active /> : roots.data?.length ? roots.data.map((root, index) => {
      const status = statuses[index]?.data;
      return <div className="root-row" key={root.sourceId}><div className="root-identity"><Typography.Text strong>{root.name}</Typography.Text>
        {status && <><div className="directory-statistics">{Object.entries(configuration.data?.statistics ?? {}).flatMap(([key, label]) => {
          const count = status.statistics?.[key]; return count === undefined ? [] : [<span key={key}>{label} <strong>{count.toLocaleString()}</strong></span>];
        })}</div><div className="secondary-id">更新于 {new Date(status.completedAt).toLocaleString()}</div></>}
        {status?.error && <Typography.Text type="warning">更新失败，仍显示上次内容</Typography.Text>}
        <Failure error={statuses[index]?.error ?? null} />
      </div><Space wrap>
        <RefreshPolicyControl api={api} instanceId={instance.id} directoryRef={root.directoryRef} disabled={busy} />
        {(status?.pendingFileInfo ?? 0) > 0 && <Button disabled={busy} onClick={() => refresh.start({ kind: 'file-info', directoryRef: root.directoryRef })}>准备文件</Button>}
        <Button icon={<ReloadOutlined aria-hidden="true" />} disabled={busy} loading={refresh.active && refresh.view?.scope.kind === 'directory' && refresh.view.scope.directoryRef === root.directoryRef} onClick={() => refresh.start({ kind: 'directory', directoryRef: root.directoryRef })}>{status ? '更新' : '加载歌曲'}</Button>
      </Space></div>;
    }) : !roots.isError && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有可浏览的内容" />}
  </>;
}
