// Keep the upstream SDK and its entry point owned by this plugin, including runtime probes.
export { handleRequest } from '@yakult-green-tea/qq-music-api/serverless';
export type { handleRequest as QqRequestHandler } from '@yakult-green-tea/qq-music-api/serverless';
