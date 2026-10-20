/** Browser-visible desktop mounting contract. Credentials only occur in input. */
export type MountInput = {
  name?: string;
  mountPoint: string;
  source: { kind: 'local' } | { kind: 'remote'; url: string; username: string; password: string };
};

export type MountView = {
  id: string;
  name: string;
  mountPoint: string;
  source: { kind: 'local' } | { kind: 'remote'; url: string };
  state: 'starting' | 'mounted' | 'unmounting' | 'stopped' | 'error';
  error?: { code: string; message: string };
};

export interface MountManager {
  list(): Promise<MountView[]>;
  mount(input: MountInput): Promise<MountView>;
  remount(id: string): Promise<MountView>;
  unmount(id: string): Promise<MountView>;
  remove(id: string): Promise<void>;
  close(): Promise<void>;
}
