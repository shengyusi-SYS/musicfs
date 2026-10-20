import { Alert, Button } from 'antd';
import { ApiError } from '../api';

export function Failure({ error, retry, reauthorize }: { error: Error | null; retry?: (() => void) | undefined; reauthorize?: (() => void) | undefined }) {
  if (!error) return null;
  const needsAuth = error instanceof ApiError && error.fault?.kind === 'needs_auth' && reauthorize;
  const hint = error instanceof ApiError && error.code && ['conflict', 'stale_call', 'invalid_auth_action'].includes(error.code)
    ? '状态已发生变化，请重新载入后再操作。' : undefined;
  return <Alert className="feedback" showIcon type="error" title={hint ?? error.message} description={hint ? error.message : undefined}
    action={needsAuth ? <Button size="small" onClick={reauthorize}>重新授权</Button> : retry && <Button size="small" onClick={retry}>重试</Button>} />;
}
