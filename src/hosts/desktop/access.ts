import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { createManagementAuth, MANAGEMENT_AUTH_SCHEMA_SQL } from '../../infrastructure/management-auth';

/** Management accounts have their own lifecycle, separate from music snapshots and source sessions. */
export function createDesktopAccess(directory: string, adminToken: string, instanceId?: string) {
  const database = new Database(join(directory, 'auth.sqlite'), { create: true, strict: true });
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  database.exec(MANAGEMENT_AUTH_SCHEMA_SQL);
  const auth = createManagementAuth({ database, adminToken, ...(instanceId ? { instanceId } : {}) });
  return { ...auth, close: () => database.close() };
}
