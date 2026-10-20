/** Desktop-only setup for the operating system's filesystem bridge. */
export type MountPrerequisitesView = {
  kind: 'winfsp' | 'none';
  state: 'not_required' | 'ready' | 'missing' | 'restart_required' | 'error';
  canInstall: boolean;
  message: string;
  version?: string;
};

export interface MountPrerequisites {
  inspect(): Promise<MountPrerequisitesView>;
  installWinFsp(): Promise<MountPrerequisitesView>;
  check(): Promise<void>;
}
