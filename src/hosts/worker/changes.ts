import type { D1Database } from '@cloudflare/workers-types';
import type { PluginManifest } from '@musicfs/plugin-api';
import type { PluginChange } from '../../contracts/plugin-changes';
import { assertInstallationCandidate, ExtensionError, type Installation } from '../../core/extensions';
import { preparePluginMigration } from '../../core/sources';
import { createPluginActivation, needsMigration, terminalChange, type ChangeLease, type PluginChangeRecord } from '../../application/change-plugin';
import { readPackage } from '../../infrastructure/archives';
import { createD1Store } from '../../infrastructure/persistence/d1';
import type { RegisteredPlugin } from './plugins';
import { createWorkerPublisher, workerModuleType, type WorkerArtifact, type WorkerModule } from './publisher';
import { getLogger } from '@logtape/logtape';
import { errorFields } from '../../infrastructure/logging';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Serializes changes to one deployed code collection; account state stays in D1. */
export function createWorkerChanges(input: { db: D1Database; registrations: RegisteredPlugin[]; waitUntil: (work: Promise<unknown>) => void;
  accountId?: string; scriptName?: string; apiToken?: string; fetcher?: typeof fetch }) {
  const store = createD1Store(input.db);
  const activation = createPluginActivation({ store, prepare: preparePluginMigration });
  const configured = () => {
    if (!input.accountId || !input.scriptName || !input.apiToken) throw new ExtensionError('host_not_configured', '请先配置 Worker 发布所需的账号、Worker 名称和 API Token。');
    return createWorkerPublisher({ accountId: input.accountId, scriptName: input.scriptName, apiToken: input.apiToken, ...(input.fetcher ? { fetcher: input.fetcher } : {}) });
  };
  async function stagedFiles(id: string): Promise<WorkerModule[]> {
    const rows = await input.db.prepare('SELECT name, bytes FROM worker_plugin_change_files WHERE operation_id = ? ORDER BY name, chunk_index')
      .bind(id).all<{ name: string; bytes: ArrayBuffer }>();
    const groups = new Map<string, Uint8Array[]>();
    for (const row of rows.results) { const chunks = groups.get(row.name) ?? []; chunks.push(new Uint8Array(row.bytes)); groups.set(row.name, chunks); }
    return [...groups].map(([name, chunks]) => {
      const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0)); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { name, bytes, type: workerModuleType(name) };
    });
  }
  async function candidate(operation: PluginChangeRecord, current: WorkerArtifact): Promise<{ artifact: WorkerArtifact; registry: string }> {
    if (!current.modules.some(module => module.name === 'core.mjs')) throw new Error('Worker core module is missing');
    const active = (await store.installations()).filter(item => item.status === 'active');
    const packages: Pick<Installation, 'manifest' | 'revision'>[] = [...active];
    if (operation.view.kind === 'install' && !packages.some(item => item.manifest.id === operation.manifest.id && item.revision === operation.revision)) {
      packages.push({ manifest: operation.manifest, revision: operation.revision });
    }
    // Keep the previous executable revision until the D1 activation succeeds, even
    // for removal. A subsequent change drops revisions no longer used by D1.
    const revisions = new Set(packages.map(item => item.revision));
    const modules = current.modules.filter(module => !module.name.startsWith('plugins/') || revisions.has(module.name.split('/')[1]!));
    if (operation.view.kind === 'install') {
      for (const module of await stagedFiles(operation.view.operationId)) {
        const name = `plugins/${operation.revision}/${module.name}`;
        if (!modules.some(item => item.name === name)) modules.push({ ...module, name });
      }
    }
    const imports = packages.map((item, index) => `import plugin${index} from ${JSON.stringify('./plugins/' + item.revision + '/' + item.manifest.hosts.worker)};`);
    const registrations = packages.map((item, index) => `{id:${JSON.stringify(item.manifest.id)},revision:${JSON.stringify(item.revision)},module:plugin${index}}`);
    const registry = `// MusicFS change ${operation.view.operationId}\nimport {assertPluginModule} from './core.mjs';\n${imports.join('\n')}\n${packages.map((_, i) => `assertPluginModule(plugin${i});`).join('\n')}\nexport const registrations=[${registrations.join(',')}];\n`;
    return { registry, artifact: { mainModule: current.mainModule,
      modules: [...modules.filter(module => module.name !== 'registry.mjs'), { name: 'registry.mjs', type: 'esm', bytes: encoder.encode(registry) }] } };
  }
  async function publish(held: ChangeLease, signal: AbortSignal): Promise<ChangeLease | null> {
    let lease = held;
    try {
      const publisher = configured();
      if (!lease.record.registry) {
        const next = await candidate(lease.record, await publisher.content(signal));
        const saved = await activation.checkpoint(lease, { ...lease.record, registry: next.registry, attemptedAt: Date.now(),
          view: { ...lease.record.view, status: 'uploading' } });
        if (!saved) return null;
        lease = saved;
        // The durable intent precedes PUT. A lost response resumes verification,
        // never an unrecorded repeat upload from a later Worker invocation.
        await publisher.replace(next.artifact, signal);
      }
      const verifying = await activation.checkpoint(lease, { ...lease.record, view: { ...lease.record.view, status: 'verifying' } });
      if (!verifying) return null;
      lease = verifying;
      const actual = await publisher.content(signal);
      if (decoder.decode(actual.modules.find(module => module.name === 'registry.mjs')?.bytes) === lease.record.registry) {
        const view: PluginChange = { ...lease.record.view, status: needsMigration(lease.record) ? 'migrating' : 'verifying' };
        delete view.error;
        return activation.checkpoint(lease, { ...lease.record, codeReady: true, view });
      }
      if (Date.now() - (lease.record.attemptedAt ?? Date.now()) > 120_000) {
        return activation.fail(lease, 'deployment_unconfirmed', '未确认候选代码已发布，原安装仍然保留。请检查发布状态后重试。');
      }
      return lease;
    } catch (error) {
      getLogger(['musicfs', 'plugins']).error('Plugin publication failed or remains unconfirmed', { operationId: lease.record.view.operationId,
        pluginId: lease.record.manifest.id, ...errorFields(error) });
      const httpStatus = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
      if (!lease.record.registry || httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) {
        return activation.fail(lease, 'deployment_failed', 'Worker 拒绝发布或准备失败，原安装保持可用。');
      }
      if (error instanceof ExtensionError) return activation.fail(lease, error.code, error.message);
      if (Date.now() - (lease.record.attemptedAt ?? Date.now()) > 120_000) {
        return activation.fail(lease, 'deployment_unconfirmed', '暂时无法核对云端发布，原安装仍然保留。恢复连接后可重新发起变更。');
      }
      return activation.checkpoint(lease, { ...lease.record, view: { ...lease.record.view, status: 'verifying',
        error: { code: 'deployment_unconfirmed', message: '正在核对 Worker 的实际发布结果，原安装尚未切换。' } } });
    }
  }
  async function run(id: string, signal: AbortSignal = AbortSignal.timeout(25_000)) {
    const pending = await store.changeRecord(id);
    if (!pending || terminalChange(pending.view)) return;
    if (pending.stagingReady === false && Date.now() - Date.parse(pending.view.createdAt) <= 120_000) return;
    const token = crypto.randomUUID(); const now = Date.now();
    let lease = await store.claimChange(id, token, now, now + 60_000);
    if (!lease) return;
    try {
      if (lease.record.stagingReady === false) {
        await activation.fail(lease, 'staging_failed', '插件暂存未完成，原安装保持可用。请重新上传插件。');
        return;
      }
      lease = await activation.capture(lease);
      if (!lease || terminalChange(lease.record.view)) return;
      if (!lease.record.codeReady) lease = await publish(lease, signal);
      if (!lease || !lease.record.codeReady || terminalChange(lease.record.view)) return;
      const target = lease.record;
      const candidateModule = input.registrations.find(item => item.id === target.manifest.id && item.revision === target.revision)?.module;
      await activation.step(lease, candidateModule, signal);
    } finally { await store.releaseChange(id, token); }
  }
  function schedule(id: string) { input.waitUntil(run(id).catch(error => {
    getLogger(['musicfs', 'plugins']).error('Background plugin change failed', { operationId: id, ...errorFields(error) });
  })); }
  async function enqueue(kind: PluginChange['kind'], installation: { manifest: PluginManifest; revision: string }, previous: Installation | undefined, files?: ReadonlyMap<string, Uint8Array>) {
    const now = new Date().toISOString();
    const operation: PluginChangeRecord = { view: { operationId: crypto.randomUUID(), kind, pluginId: installation.manifest.id, status: 'queued', createdAt: now, updatedAt: now },
      expectedGeneration: previous?.generation ?? null, ...(previous ? { previousManifest: previous.manifest } : {}),
      stagingReady: false, manifest: installation.manifest, revision: installation.revision };
    if (!await store.createChange(operation)) {
      throw new ExtensionError('change_in_progress', '另一个插件变更仍在进行，请等待完成后重试。');
    }
    try {
      if (files) {
        const statements = [];
        for (const [name, bytes] of files) for (let offset = 0; offset < bytes.length || offset === 0; offset += 32 * 1024) {
          statements.push(input.db.prepare('INSERT INTO worker_plugin_change_files (operation_id, name, chunk_index, bytes) VALUES (?, ?, ?, ?)')
            .bind(operation.view.operationId, name, offset / (32 * 1024), bytes.slice(offset, offset + 32 * 1024)));
        }
        for (let offset = 0; offset < statements.length; offset += 50) await input.db.batch(statements.slice(offset, offset + 50));
      }
      const token = crypto.randomUUID(); const instant = Date.now();
      const lease = await store.claimChange(operation.view.operationId, token, instant, instant + 60_000);
      if (lease) {
        let ready = false;
        try {
          const staged = await activation.checkpoint(lease, { ...lease.record, stagingReady: true });
          ready = staged !== null;
        } finally { await store.releaseChange(operation.view.operationId, token); }
        if (ready) schedule(operation.view.operationId);
      }
    } catch (error) {
      getLogger(['musicfs', 'plugins']).error('Plugin staging failed', { operationId: operation.view.operationId, ...errorFields(error) });
      const token = crypto.randomUUID(); const instant = Date.now();
      const lease = await store.claimChange(operation.view.operationId, token, instant, instant + 60_000);
      if (lease) {
        try { await activation.fail(lease, 'staging_failed', '插件暂存失败，原安装保持可用。'); }
        finally { await store.releaseChange(operation.view.operationId, token); }
      }
    }
    return (await store.changeRecord(operation.view.operationId))?.view ?? operation.view;
  }
  return {
    async install(archive: Uint8Array, signal: AbortSignal): Promise<PluginChange> {
      configured(); const prepared = await readPackage(archive, 'worker', signal);
      const previous = await store.installation(prepared.manifest.id); assertInstallationCandidate(previous, prepared);
      return enqueue('install', { manifest: prepared.manifest, revision: prepared.digest }, previous, prepared.files);
    },
    async remove(id: string, signal: AbortSignal): Promise<PluginChange> {
      configured(); signal.throwIfAborted(); const previous = await store.installation(id);
      if (!previous) throw new ExtensionError('missing_plugin', 'Plugin is not installed');
      return enqueue('remove', previous, previous);
    },
    async get(id: string): Promise<PluginChange | null> {
      const operation = await store.changeRecord(id); if (!operation) return null;
      if (!terminalChange(operation.view)) schedule(id);
      return operation.view;
    },
    async stepNext(signal: AbortSignal): Promise<boolean> {
      const id = (await store.readyChanges(Date.now(), 1))[0];
      if (!id) return false;
      await run(id, signal);
      return true;
    }
  };
}
