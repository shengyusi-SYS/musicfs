import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1Store } from '../../src/infrastructure/persistence/d1';
import { createWorkerRegistry } from '../../src/hosts/worker/plugins';
import { createSources } from '../../src/core/sources';
import { createLibrary } from '../../src/core/library';
import { createDav } from './nephele-dav';
import sample from '../../plugins/sample';

const bindings = env as { DB: D1Database; PLUGIN_REVISION: string };
const store = createD1Store(bindings.DB);
const registry = createWorkerRegistry(store, [{ id: 'org.musicfs.sample', revision: bindings.PLUGIN_REVISION, module: sample }]);
const library = createLibrary(createSources(store, registry), store);
const server = createServer(createDav(library.files, { username: 'reader', password: 'fixture-password' }));
server.listen(3000);
export default httpServerHandler({ port: 3000 });
