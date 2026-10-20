export type DesktopHttpsView = {
  platform: string;
  enabled: boolean;
  davUrl: string | null;
  certificate: { fingerprintSha256: string; expiresAt: string } | null;
  trusted: boolean;
  webClient: 'running' | 'stopped' | 'missing' | null;
  error: string | null;
};

export interface DesktopHttps {
  inspect(): Promise<DesktopHttpsView>;
  enable(): Promise<DesktopHttpsView>;
  trust(): Promise<DesktopHttpsView>;
  disable(): Promise<DesktopHttpsView>;
  close(): Promise<void>;
}
