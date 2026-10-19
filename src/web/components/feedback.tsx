import { Alert, Button } from 'antd';
import { ApiError } from '../api';

export function Failure({ error, retry }: { error: Error | null; retry?: () => void }) {
  if (!error) return null;
  const hint = error instanceof ApiError && error.status === 409 ? '状态已发生变化，请重新载入后再操作。' : undefined;
  return <Alert className="feedback" showIcon type="error" title={hint ?? error.message} description={hint ? error.message : undefined}
    action={retry && <Button size="small" onClick={retry}>重试</Button>} />;
}
