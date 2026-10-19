import type { PluginInstallation } from './management';

/** Public progress only; deployment credentials and packaged code remain on the host. */
export type PluginChange = {
  operationId: string;
  kind: 'install' | 'remove';
  pluginId: string;
  status: 'queued' | 'uploading' | 'deploying' | 'verifying' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  installation?: PluginInstallation;
  error?: { code: string; message: string };
};
