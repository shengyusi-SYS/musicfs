export type DesktopHttpsView = {
  platform: string;
  enabled: boolean;
  davUrl: string | null;
  certificate: { fingerprintSha256: string; expiresAt: string } | null;
  trust: { currentUser: boolean; localMachine: boolean };
  error: string | null;
};

export interface DesktopHttps {
  inspect(): Promise<DesktopHttpsView>;
  enable(): Promise<DesktopHttpsView>;
  trust(scope?: 'current-user' | 'local-machine'): Promise<DesktopHttpsView>;
  disable(): Promise<DesktopHttpsView>;
  close(): Promise<void>;
}
