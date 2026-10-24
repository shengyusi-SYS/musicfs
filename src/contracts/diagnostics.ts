export const diagnosticLevels = ['trace', 'debug', 'info', 'warning', 'error', 'fatal'] as const;
export type DiagnosticLevel = typeof diagnosticLevels[number];
export const nativeLogLevels = ['ERROR', 'NOTICE', 'INFO', 'DEBUG'] as const;
export type NativeLogLevel = typeof nativeLogLevels[number];
export type DiagnosticSettings = { level: DiagnosticLevel; nativeLevel: NativeLogLevel };
export type DesktopDiagnosticsView = {
  settings: DiagnosticSettings;
  version: string;
  revision: string;
  startedAt: string;
  directory: string;
  fileLogging: boolean;
  nativeAvailable: boolean;
};
