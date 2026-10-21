import type { BunPlugin } from 'bun';

/** Keep Worker nodejs_compat crypto native; Bun's browser polyfill is larger and lacks this export at runtime. */
export const workerCrypto: BunPlugin = {
  name: 'worker-native-crypto',
  setup(builder) { builder.onResolve({ filter: /^node:crypto$/ }, ({ path }) => ({ path, external: true })); }
};
