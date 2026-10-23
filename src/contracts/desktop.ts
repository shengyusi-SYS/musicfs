/** Desktop listener settings; plugin and Worker configuration remain separate. */
export type DesktopNetworkSettings = { managementAccess: 'local' | 'lan'; managementPort: number; davAccess: 'local' | 'lan'; davPort: number };
export type DesktopNetworkView = {
  settings: DesktopNetworkSettings;
  active: DesktopNetworkSettings;
  restartRequired: boolean;
  managementUrls: string[];
  davUrls: string[];
  machine: { name: string; platform: string };
};

export type DesktopPreferences = {
  launchAtLogin: boolean;
  openOnLaunch: boolean;
  openOnLogin: boolean;
  autoMount: boolean;
  retryAutoMount: boolean;
};

export type DesktopPreferencesView = {
  settings: DesktopPreferences;
  integration: { available: boolean; enabled?: boolean; error?: string };
};
