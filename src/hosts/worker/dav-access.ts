import type { D1Database } from '@cloudflare/workers-types';
import type { DavAccess, DavCredentials } from '../../contracts/dav-access';

/** D1 is authoritative across isolates; one lookup per DAV/connection request, no polling. */
export function createWorkerDavAccess(database: D1Database, defaults: DavCredentials): DavAccess {
  return {
    async get() {
      return await database.prepare('SELECT username, password FROM dav_credentials WHERE id = 1').first<DavCredentials>() ?? { ...defaults };
    },
    async save(value) {
      await database.prepare(`INSERT INTO dav_credentials (id, username, password) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET username = excluded.username, password = excluded.password`).bind(value.username, value.password).run();
    }
  };
}
