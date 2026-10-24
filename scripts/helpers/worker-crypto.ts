import type { BunPlugin } from 'bun';

/** Keep supported nodejs_compat modules native instead of bundling browser polyfills. */
export const workerCrypto: BunPlugin = {
  name: 'worker-native-crypto',
  setup(builder) { builder.onResolve({ filter: /^node:(crypto|async_hooks)$/ }, ({ path }) => ({ path, external: true })); }
};
