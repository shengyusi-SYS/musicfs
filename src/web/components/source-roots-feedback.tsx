import type { Api } from '../api';
import { Failure } from './feedback';
import { pendingRefreshId, RefreshProgress, usePersistentRefresh } from './refresh';

export function SourceRootsFeedback({ api, error, reload }: { api: Api; error: Error | null; reload: () => void }) {
  const pending = pendingRefreshId(error);
  return pending ? <PendingRoots key={pending} api={api} operationId={pending} reload={reload} /> : <Failure error={error} retry={reload} />;
}
function PendingRoots({ api, operationId, reload }: { api: Api; operationId: string; reload: () => void }) {
  const refresh = usePersistentRefresh(api, { operationId, onCompleted: reload });
  return <RefreshProgress operation={refresh} reload={reload} />;
}
