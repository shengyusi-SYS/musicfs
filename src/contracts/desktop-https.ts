export const WINDOWS_WEBDAV_FILE_LIMIT = 0xffff_ffff;

export type WindowsWebDavView = {
  trusted: boolean;
  webClient: 'running' | 'stopped' | 'missing' | null;
  fileSizeLimitBytes: number | null;
  originalFileSizeLimitBytes: number | null;
  canRestoreFileSizeLimit: boolean;
};

export type DesktopHttpsView = WindowsWebDavView & {
  platform: string;
  enabled: boolean;
  davUrl: string | null;
  certificate: { fingerprintSha256: string; expiresAt: string } | null;
  error: string | null;
};

export interface DesktopHttps {
  inspect(): Promise<DesktopHttpsView>;
  enable(): Promise<DesktopHttpsView>;
  trust(): Promise<DesktopHttpsView>;
  restoreFileSizeLimit(): Promise<DesktopHttpsView>;
  disable(): Promise<DesktopHttpsView>;
  close(): Promise<void>;
}
