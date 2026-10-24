import { Hono, type MiddlewareHandler } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import { diagnosticSettingsSchema, type DesktopLogging } from './logging';
import { reportRequestFailure, requestDiagnostics } from '../../transport/diagnostics';
import { t } from './locale';

export function createDesktopDiagnosticsHttp(input: { logging: DesktopLogging; adminToken: string; managementAuth?: MiddlewareHandler }) {
  const app = new Hono();
  app.use('/api/desktop/diagnostics*', requestDiagnostics, input.managementAuth ?? bearerAuth({ token: input.adminToken }), async (c, next) => {
    c.header('Cache-Control', 'no-store'); await next();
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    const requestId = reportRequestFailure(c, error);
    return c.json({ error: 'diagnostics_failed', message: t('日志操作未完成，请重试。'), translation: { key: '日志操作未完成，请重试。' }, requestId }, 500);
  });
  app.get('/api/desktop/diagnostics', c => c.json(input.logging.inspect()));
  app.put('/api/desktop/diagnostics', async c => {
    const parsed = diagnosticSettingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_diagnostics', message: t('请选择有效的日志级别。'), translation: { key: '请选择有效的日志级别。' } }, 422);
    return c.json(await input.logging.configure(parsed.data));
  });
  app.get('/api/desktop/diagnostics/download', async () => new Response(await input.logging.archive(), {
    headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="musicfs-diagnostics.zip"' }
  }));
  return app;
}
