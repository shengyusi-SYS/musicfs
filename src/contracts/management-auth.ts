/** Management login is independent of music-source authorization and DAV credentials. */
export type ManagementAccess = {
  authenticated: boolean;
  passwordConfigured: boolean;
  username?: string;
  host?: 'desktop' | 'worker';
};
export type AccessView = ManagementAccess;

export type ManagementLogin = { username: string; password: string; rememberMe: boolean };
export type ManagementAccount = { username: string; password: string };
export type ManagementTicket = { ticket: string; expiresAt: string };
