import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ZipWriter, Uint8ArrayWriter, TextReader } from '@zip.js/zip.js/index-native.js';
import type { PluginManifest, SourcePlugin } from '@musicfs/plugin-api';
import { readPackage } from '../../src/infrastructure/archives';
import type { RegisteredPlugin } from '../../src/hosts/worker/plugins';

/** Actual ESM bytes are both packaged and imported; no substitute candidate module. */
export async function workerMigrationFixture(directory: string, version: 1 | 2) {
  const manifest: PluginManifest = { formatVersion: 1, id: 'org.musicfs.fixture.migration', name: '迁移夹具', version: `${version}.0.0`,
    apiRange: '>=0.1.4 <0.2.0', configVersion: version, stateVersion: version, hosts: { worker: 'index.mjs' }, files: ['index.mjs'] };
  const code = `
export const validationCalls = [];
const version = ${version};
export default {
  configuration: { schema: { type: 'object' } },
  async validateConfig(ctx, config) {
    validationCalls.push(ctx.instanceId);
    return version === 1 || typeof config.title === 'string'
      ? { ok: true, value: config } : { ok: false, error: { kind: 'invalid_config', message: 'Invalid fixture config' } };
  },
  migrateConfig({ fromVersion, config }) {
    if (version !== 2 || fromVersion !== 1) throw new Error('Unsupported fixture config version');
    return { title: config.label };
  },
  migrateState({ fromVersion, state }) {
    if (version !== 2 || fromVersion !== 1 || state.reject) throw new Error('Unsupported fixture state');
    return { session: { token: state.token }, version: 2 };
  },
  validateState({ state }) { return version === 2 && state?.version === 2 && typeof state?.session?.token === 'string'; },
  async roots(ctx) { return { ok: true, value: { items: [{ sourceId: 'root', directoryRef: 'root', name: version === 1 ? ctx.config.label : ctx.config.title }] } }; },
  async list() { return { ok: true, value: { items: [] } }; },
  async stat() { return { ok: false, error: { kind: 'not_supported', message: 'Unused fixture stat' } }; },
  async open() { return { ok: false, error: { kind: 'not_supported', message: 'Unused fixture open' } }; }
};`;
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: false });
  await writer.add('manifest.json', new TextReader(JSON.stringify(manifest)));
  await writer.add('index.mjs', new TextReader(code));
  const archive = await writer.close();
  const prepared = await readPackage(archive, 'worker', new AbortController().signal);
  const folder = join(directory, `plugin-v${version}`); await mkdir(folder, { recursive: true });
  const path = join(folder, 'index.mjs'); await writeFile(path, code);
  const loaded = await import(pathToFileURL(path).href) as { default: SourcePlugin; validationCalls: string[] };
  const registration: RegisteredPlugin = { id: manifest.id, revision: prepared.digest, module: loaded.default };
  return { archive, prepared, registration, validationCalls: loaded.validationCalls };
}
