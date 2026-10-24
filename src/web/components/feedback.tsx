import { t, messageText } from '../i18n';
import { Alert, Button } from 'antd';
import { ApiError } from '../api';

export function Failure({ error, retry, reauthorize }: { error: Error | null; retry?: (() => void) | undefined; reauthorize?: (() => void) | undefined }) {
  if (!error) return null;
  const needsAuth = error instanceof ApiError && error.fault?.kind === 'needs_auth' && reauthorize;
  return <Alert className="feedback" showIcon type="error" title={messageText(error)}
    action={needsAuth ? <Button size="small" onClick={reauthorize}>{t("重新授权")}</Button> : retry && <Button size="small" onClick={retry}>{t("重试")}</Button>} />;
}
