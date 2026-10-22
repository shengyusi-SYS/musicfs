import type { DavCredentials } from '../contracts/dav-access';

/** URL userinfo is plain connection data; the URL implementation handles escaping. */
export function davImportUrl(address: string, credentials: DavCredentials): string {
  const url = new URL(address);
  url.username = encodeURIComponent(credentials.username);
  url.password = encodeURIComponent(credentials.password);
  return url.href;
}
