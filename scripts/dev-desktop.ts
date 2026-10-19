import { resolve } from 'node:path';
import { createDesktopService } from '../src/hosts/desktop/service';

const { MUSICFS_ADMIN_TOKEN, MUSICFS_DAV_PASSWORD } = process.env;
if (!MUSICFS_ADMIN_TOKEN || !MUSICFS_DAV_PASSWORD) throw new Error('Set MUSICFS_ADMIN_TOKEN and MUSICFS_DAV_PASSWORD for the development service');
const service = await createDesktopService({ directory: resolve('dist/dev-data'), adminToken: MUSICFS_ADMIN_TOKEN,
  dav: { username: 'musicfs', password: MUSICFS_DAV_PASSWORD }, webRoot: resolve('dist/web') });
const server = Bun.serve({ hostname: '127.0.0.1', port: 8787, fetch: service.app.fetch });
console.log(`Development service: ${server.url.origin} (credentials omitted)`);
async function stop() { await server.stop(true); service.close(); process.exit(0); }
process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
