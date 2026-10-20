import { zipSync, strToU8 } from 'fflate';
import type { PluginManifest } from '@musicfs/plugin-api';

/** Real installed ESM; HTTP gates let the test overlap old reads and candidate validation. */
export function desktopMigrationFixture(version: 1 | 2) {
  const manifest: PluginManifest = { formatVersion: 1, id: 'org.musicfs.fixture.desktop-migration', name: '桌面迁移夹具',
    version: `${version}.0.0`, apiRange: '>=0.1.4 <0.2.0', configVersion: version, stateVersion: version,
    hosts: { desktop: 'index.mjs' }, files: ['index.mjs'] };
  const code = `
const version = ${version};
const info = { contentId: 'fixture-bytes-v1', size: 12, mediaType: 'audio/wav' };
export default {
  configuration: { schema: { type: 'object', properties: version === 1
    ? { label: { type: 'string', title: '目录名称' }, server: { type: 'string', title: '来源地址' } }
    : { title: { type: 'string', title: '升级后的目录名称' }, endpoint: { type: 'string', title: '升级后的来源地址' } } } },
  async validateConfig(ctx, config) {
    if (version === 2) await ctx.fetch(config.endpoint + '/candidate', { signal: ctx.signal });
    return { ok: true, value: config, nextPrivateState: ctx.privateState ?? { token: 'fixture-secret-' + ctx.instanceId } };
  },
  migrateConfig({ config }) {
    if (config.reject) throw new Error('fixture-secret-do-not-publish');
    return { title: config.label, endpoint: config.server };
  },
  migrateState({ state }) { return { session: state.token, version: 2 }; },
  validateState({ state }) { return state?.version === 2 && typeof state?.session === 'string'; },
  async roots(ctx) { return { ok: true, value: { items: [{ sourceId: 'audio', directoryRef: 'audio', name: version === 1 ? ctx.config.label : ctx.config.title }] } }; },
  async list() { return { ok: true, value: { items: [{ kind: 'file', entryId: 'tone', name: 'fixture.wav', fileRef: 'tone', info }] } }; },
  async stat(ctx) {
    if (version === 1 && await (await ctx.fetch(ctx.config.server + '/stat', { signal: ctx.signal })).text() === 'late')
      return { ok: true, value: info, nextPrivateState: { token: 'fixture-stale-secret' } };
    return { ok: true, value: info };
  },
  async open(_ctx, _file, request) {
    const bytes = new TextEncoder().encode('RIFFfixture!'); const range = request.range;
    return { ok: true, value: { content: info, servedRange: range ?? null,
      body: new Response(range ? bytes.slice(range.start, range.end + 1) : bytes).body } };
  }
};`;
  return { manifest, archive: zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'index.mjs': strToU8(code) }) };
}
