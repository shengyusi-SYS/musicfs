import { AsyncLocalStorage } from 'node:async_hooks';
import { configureSync, getConfig, getConsoleSink, getLevelFilter, getLogger, getThrottlingFilter, isLogLevel, jsonLinesFormatter, type Sink } from '@logtape/logtape';

/** Hosts select destinations. Domains never configure logging or retain requests. */
export function configureApplicationLogging(sinks: Record<string, Sink>, level = 'warning') {
  let current = isLogLevel(level) ? level : 'warning';
  let minimum = getLevelFilter(current);
  configureSync({ reset: true, sinks, contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
    filters: { minimum: record => minimum(record), io: getThrottlingFilter({ limit: 20, windowMs: 60_000, maxKeys: 128,
      key: record => JSON.stringify([record.category, record.level, record.rawMessage,
        record.properties.errorCode, record.properties.sourceFaultKind, record.properties.ioStage,
        record.properties.errorType, record.properties.failureKind, record.properties.timedOut]),
      summary: { logger: getLogger(['musicfs', 'diagnostics']), level: summary => summary.firstRecord.level } }) }, loggers: [
    { category: 'musicfs', lowestLevel: 'trace', filters: ['minimum'], sinks: Object.keys(sinks) },
    { category: ['musicfs', 'io'], filters: ['minimum', 'io'] },
    { category: ['musicfs', 'http'], filters: ['minimum', 'io'] },
    { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: Object.keys(sinks) }
  ] });
  return { get level() { return current; }, setLevel(next: string) {
    if (!isLogLevel(next)) throw new Error('Invalid log level');
    current = next; minimum = getLevelFilter(next);
  } };
}

export function configureWorkerLogging(level?: string) {
  if (getConfig()) return;
  configureApplicationLogging({ console: getConsoleSink({ formatter: record => [JSON.parse(jsonLinesFormatter(record))] }) }, level);
}

/** Error messages can contain provider URLs or credentials; record type/code and call sites instead. */
export function errorFields(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { errorType: typeof error };
  const fault = 'sourceFault' in error ? error.sourceFault : undefined;
  return { errorType: error.name,
    ...('code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? { errorCode: error.code } : {}),
    ...('status' in error && typeof error.status === 'number' ? { upstreamStatus: error.status } : {}),
    ...('operationId' in error && typeof error.operationId === 'string' ? { operationId: error.operationId } : {}),
    ...('syscall' in error && typeof error.syscall === 'string' ? { syscall: error.syscall } : {}),
    ...(fault && typeof fault === 'object' && 'kind' in fault && typeof fault.kind === 'string' ? { sourceFaultKind: fault.kind } : {}),
    frames: error.stack?.split('\n').filter(line => /^\s+at\s/.test(line)).slice(0, 8),
    ...(error.cause && depth < 1 ? { cause: errorFields(error.cause, depth + 1) } : {})
  };
}
