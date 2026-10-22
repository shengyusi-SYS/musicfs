/** Read-only player credentials, independent of the management account. */
export type DavCredentials = { username: string; password: string };
export type DavAccess = {
  get(): DavCredentials | Promise<DavCredentials>;
  save(value: DavCredentials): Promise<void>;
};
