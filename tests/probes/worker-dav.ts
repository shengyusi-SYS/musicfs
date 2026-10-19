import type { D1Database } from '@cloudflare/workers-types';
import { createD1Store } from '../../src/infrastructure/persistence/d1';
import { createWorkerRegistry } from '../../src/hosts/worker/plugins';
import { createSources } from '../../src/core/sources';
import { createLibrary } from '../../src/core/library';
import { createDav } from '../../src/transport/dav';
import { createExtensions } from '../../src/core/extensions';
import { createManagementApi } from '../../src/transport/http';
import sample from '../../plugins/sample';

export default {
  fetch(request: Request, bindings: { DB: D1Database; PLUGIN_REVISION: string }) {
    const store = createD1Store(bindings.DB);
    const registry = createWorkerRegistry(store, [{ id: 'org.musicfs.sample', revision: bindings.PLUGIN_REVISION, module: sample }]);
    const sources = createSources(store, registry);
    const library = createLibrary(sources, store);
    if (new URL(request.url).pathname.startsWith('/api/')) return createManagementApi({ host: 'worker', adminToken: 'fixture-admin', sources, library,
      extensions: createExtensions(store, async () => {}), maxPackageBytes: 1024,
      install: async () => { throw new Error('Installation is unused in this probe'); } }).fetch(request);
    return createDav(library.files, { username: 'reader', password: 'fixture-password' }, {
      fixedLength: size => new FixedLengthStream(size) as unknown as TransformStream<Uint8Array, Uint8Array>
    }).fetch(request);
  }
};
