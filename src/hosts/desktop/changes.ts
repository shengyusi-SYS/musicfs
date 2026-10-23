import { t } from './locale';
import { createPluginActivation, needsMigration, terminalChange, type PluginChangeRecord, type PluginChangeStore } from '../../application/change-plugin';
import { assertInstallationCandidate, ExtensionError, type Extensions, type InstallationStore, type PreparedPackage } from '../../core/extensions';
import { preparePluginMigration } from '../../core/sources';
import type { createDesktopPlugins } from './plugins';

/** Compatible installs stay immediate; schema upgrades use durable candidate preparation. */
export function createDesktopChanges(input: { store: PluginChangeStore & InstallationStore;
  plugins: ReturnType<typeof createDesktopPlugins>; extensions: Extensions }) {
  const activation = createPluginActivation({ store: input.store, prepare: preparePluginMigration });
  return {
    async install(prepared: PreparedPackage, signal: AbortSignal) {
      const previous = await input.store.installation(prepared.manifest.id);
      assertInstallationCandidate(previous, prepared);
      const now = new Date().toISOString();
      const record: PluginChangeRecord = { view: { operationId: crypto.randomUUID(), kind: 'install', pluginId: prepared.manifest.id,
        status: 'queued', createdAt: now, updatedAt: now }, expectedGeneration: previous?.generation ?? null,
        ...(previous ? { previousManifest: previous.manifest } : {}), manifest: prepared.manifest, revision: prepared.digest, codeReady: true };
      if (!needsMigration(record)) return input.extensions.install(prepared);
      signal.throwIfAborted();
      await input.plugins.prepare(prepared);
      signal.throwIfAborted();
      if (!await input.store.createChange(record)) throw new ExtensionError('change_in_progress', t("另一个插件变更仍在进行，请等待完成后重试。"));
      return record.view;
    },
    async get(id: string) { return (await input.store.changeRecord(id))?.view ?? null; },
    async stepNext(signal: AbortSignal): Promise<boolean> {
      signal.throwIfAborted();
      const [id] = await input.store.readyChanges(Date.now(), 1);
      if (!id) return false;
      const token = crypto.randomUUID();
      let lease = await input.store.claimChange(id, token, Date.now(), Date.now() + 60_000);
      if (!lease) return false;
      try {
        if (terminalChange(lease.record.view)) return true;
        lease = await activation.capture(lease);
        if (!lease || terminalChange(lease.record.view)) return true;
        const module = await input.plugins.candidate(lease.record.manifest, lease.record.revision);
        await activation.step(lease, module, AbortSignal.any([signal, AbortSignal.timeout(25_000)]));
      } catch {
        signal.throwIfAborted();
        if (lease) await activation.fail(lease, 'candidate_failed', t("无法准备候选插件，原安装和实例数据保持不变。"));
      } finally { await input.store.releaseChange(id, token); }
      return true;
    }
  };
}
