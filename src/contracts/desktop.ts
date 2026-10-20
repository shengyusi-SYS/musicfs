/** Desktop listener settings; plugin and Worker configuration remain separate. */
export type DesktopNetworkSettings = { access: 'local' | 'lan'; port: number };
export type DesktopNetworkView = {
  settings: DesktopNetworkSettings;
  active: DesktopNetworkSettings;
  restartRequired: boolean;
  davUrls: string[];
};
