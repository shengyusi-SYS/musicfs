import { resolve } from 'node:path';
import { createDesktopService } from '../src/hosts/desktop/service';
import { configureDesktopLogging } from '../src/hosts/desktop/logging';

const { MUSICFS_ADMIN_TOKEN, MUSICFS_DAV_PASSWORD } = process.env;
if (!MUSICFS_ADMIN_TOKEN || !MUSICFS_DAV_PASSWORD) throw new Error('Set MUSICFS_ADMIN_TOKEN and MUSICFS_DAV_PASSWORD for the development service');
const directory = resolve('dist/dev-data');
const logging = await configureDesktopLogging(directory);
const service = await createDesktopService({ directory, adminToken: MUSICFS_ADMIN_TOKEN, logging,
  dav: { username: 'musicfs', password: MUSICFS_DAV_PASSWORD }, webRoot: resolve('dist/web') });
const server = Bun.serve({ hostname: '127.0.0.1', port: 8787, fetch: service.app.fetch });
console.log(`Development service: ${server.url.origin} (credentials omitted)`);
async function stop() { await server.stop(true); await service.close(); logging.close(); process.exit(0); }
process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
