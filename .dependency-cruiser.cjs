module.exports = {
  forbidden: [
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    { name: 'plugin-contract-independent', severity: 'error',
      from: { path: '^packages/plugin-api/' }, to: { path: '^(src|plugins)/|node_modules/|^(node:|bun:)' } },
    { name: 'plugins-use-public-contract', severity: 'error',
      from: { path: '^plugins/' }, to: { path: '^src/' } },
    { name: 'audio-tags-stay-optional-to-core', severity: 'error',
      from: { path: '^src/' }, to: { path: '^packages/audio-tags/' } },
    { name: 'audio-tags-own-no-source-or-host', severity: 'error',
      from: { path: '^packages/audio-tags/' }, to: { path: '^(src|plugins)/' } },
    { name: 'platform-sdks-owned-by-plugins', severity: 'error',
      from: { path: '^(src|packages)/' }, to: { path: 'node_modules/(@yakult-green-tea/qq-music-api|NeteaseCloudMusicApi)/' } },
    { name: 'core-stays-host-independent', severity: 'error',
      from: { path: '^src/core/' }, to: { path: '^src/(hosts|transport|infrastructure|web)/|^plugins/|node_modules/(hono|@zip\\.js)/' } },
    { name: 'core-has-no-native-runtime', severity: 'error',
      from: { path: '^src/core/' }, to: { path: '^(node:|bun:)' } },
    { name: 'extensions-own-no-upper-domain', severity: 'error',
      from: { path: '^src/core/extensions/' }, to: { path: '^src/core/(sources|library)/|^src/application/' } },
    { name: 'sources-own-no-library', severity: 'error',
      from: { path: '^src/core/sources/' }, to: { path: '^src/core/library/|^src/application/' } },
    { name: 'application-stays-host-independent', severity: 'error',
      from: { path: '^src/application/' }, to: { path: '^src/(hosts|transport|infrastructure|web)/|^plugins/|^(node:|bun:)' } },
    { name: 'worker-has-no-desktop-dependencies', severity: 'error',
      from: { path: '^src/(worker\\.ts|hosts/worker/)' },
      to: { path: '^src/hosts/desktop/|^src/infrastructure/persistence/sqlite', reachable: true } },
    { name: 'web-has-no-backend', severity: 'error',
      from: { path: '^src/web/' }, to: { path: '^src/(core|application|hosts|infrastructure|transport)/' } },
    { name: 'dav-is-fetch-native', severity: 'error',
      from: { path: '^src/transport/dav/' }, to: { path: '^(node:|bun:)|node_modules/(nephele|@nephele)/' } }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'types', 'default'] },
    exclude: { path: '(^|/)(dist|node_modules)/' }
  }
};
