import type { D1Database } from '@cloudflare/workers-types';
import type { PluginManifest } from '@musicfs/plugin-api';
import type { PluginChange } from '../../contracts/plugin-changes';
import { assertInstallationCandidate, ExtensionError, type Installation } from '../../core/extensions';
import { readPackage } from '../../infrastructure/archives';
import { createD1Store } from '../../infrastructure/persistence/d1';
import type { RegisteredPlugin } from './plugins';
import { createWorkerPublisher, type WorkerArtifact, type WorkerModule } from './publisher';

type Operation = { view: PluginChange; expectedGeneration: number | null; manifest: PluginManifest; revision: string;
  registry?: string; attemptedAt?: number };
const terminal = (value: PluginChange) => value.status === 'completed' || value.status === 'failed';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const moduleType = (name: string): WorkerModule['type'] => /\.m?js$/i.test(name) ? 'esm' : /\.(json|txt|md)$/i.test(name) ? 'text' : 'data';

/** Serializes changes to one deployed code collection; account state stays in D1. */
export function createWorkerChanges(input: { db: D1Database; registrations: RegisteredPlugin[]; waitUntil: (work: Promise<unknown>) => void;
  accountId?: string; scriptName?: string; apiToken?: string; fetcher?: typeof fetch }) {
  const store = createD1Store(input.db);
  const configured = () => {
    if (!input.accountId || !input.scriptName || !input.apiToken) throw new ExtensionError('host_not_configured', '请先配置 Worker 发布所需的账号、Worker 名称和 API Token。');
    return createWorkerPublisher({ accountId: input.accountId, scriptName: input.scriptName, apiToken: input.apiToken, ...(input.fetcher ? { fetcher: input.fetcher } : {}) });
  };
  const load = async (id: string): Promise<Operation | undefined> => {
    const row = await input.db.prepare('SELECT document FROM worker_plugin_changes WHERE operation_id = ?').bind(id).first<{ document: string }>();
    return row ? JSON.parse(row.document) as Operation : undefined;
  };
  async function save(operation: Operation) {
    operation.view.updatedAt = new Date().toISOString();
    await input.db.prepare('UPDATE worker_plugin_changes SET status = ?, document = ? WHERE operation_id = ?')
      .bind(operation.view.status, JSON.stringify(operation), operation.view.operationId).run();
  }
  async function failed(operation: Operation, code: string, message: string) {
    operation.view.status = 'failed'; operation.view.error = { code, message }; await save(operation);
    await input.db.prepare('DELETE FROM worker_plugin_change_files WHERE operation_id = ?').bind(operation.view.operationId).run();
  }
  async function complete(operation: Operation) {
    let current = await store.installation(operation.manifest.id);
    const alreadyApplied = current?.generation === (operation.expectedGeneration ?? 0) + 1
      && (operation.view.kind === 'install' ? current.status === 'active' && current.revision === operation.revision : current.status === 'missing');
    if (!alreadyApplied) {
      if ((current?.generation ?? null) !== operation.expectedGeneration) throw new ExtensionError('revision_conflict', 'Plugin installation changed during deployment');
      if (operation.view.kind === 'install') current = await store.activate(operation.manifest, operation.revision, operation.expectedGeneration);
      else { await store.markMissing(operation.manifest.id, operation.expectedGeneration!); current = await store.installation(operation.manifest.id); }
    }
    operation.view.status = 'completed'; delete operation.view.error;
    if (current) operation.view.installation = current;
    await save(operation);
    await input.db.prepare('DELETE FROM worker_plugin_change_files WHERE operation_id = ?').bind(operation.view.operationId).run();
  }
  async function stagedFiles(id: string): Promise<WorkerModule[]> {
    const rows = await input.db.prepare('SELECT name, bytes FROM worker_plugin_change_files WHERE operation_id = ? ORDER BY name, chunk_index')
      .bind(id).all<{ name: string; bytes: ArrayBuffer }>();
    const groups = new Map<string, Uint8Array[]>();
    for (const row of rows.results) { const chunks = groups.get(row.name) ?? []; chunks.push(new Uint8Array(row.bytes)); groups.set(row.name, chunks); }
    return [...groups].map(([name, chunks]) => {
      const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0)); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { name, bytes, type: moduleType(name) };
    });
  }
  async function candidate(operation: Operation, current: WorkerArtifact): Promise<WorkerArtifact> {
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
    operation.registry = `// MusicFS change ${operation.view.operationId}\nimport {assertPluginModule} from './core.mjs';\n${imports.join('\n')}\n${packages.map((_, i) => `assertPluginModule(plugin${i});`).join('\n')}\nexport const registrations=[${registrations.join(',')}];\n`;
    return { mainModule: current.mainModule, modules: [...modules.filter(module => module.name !== 'registry.mjs'), { name: 'registry.mjs', type: 'esm', bytes: encoder.encode(operation.registry) }] };
  }
  async function run(id: string) {
    const lease = crypto.randomUUID();
    const claimed = await input.db.prepare("UPDATE worker_plugin_changes SET lease_token = ?, lease_until = ? WHERE operation_id = ? AND status NOT IN ('completed','failed') AND lease_until < ?")
      .bind(lease, Date.now() + 60_000, id, Date.now()).run();
    if (claimed.meta.changes !== 1) return;
    const operation = await load(id); if (!operation || terminal(operation.view)) return;
    const publisher = configured(); const signal = AbortSignal.timeout(25_000);
    try {
      if (!operation.registry) {
        const artifact = await candidate(operation, await publisher.content(signal));
        operation.view.status = 'uploading'; operation.attemptedAt = Date.now(); await save(operation);
        await publisher.replace(artifact, signal);
      }
      operation.view.status = 'verifying'; await save(operation);
      const actual = await publisher.content(signal);
      if (decoder.decode(actual.modules.find(module => module.name === 'registry.mjs')?.bytes) === operation.registry) await complete(operation);
      else if (Date.now() - (operation.attemptedAt ?? Date.now()) > 120_000) await failed(operation, 'deployment_unconfirmed', '未确认候选代码已发布，原安装仍然保留。请检查发布状态后重试。');
    } catch (error) {
      const httpStatus = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
      if (!operation.registry || httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) {
        await failed(operation, 'deployment_failed', 'Worker 拒绝发布或准备失败，原安装保持可用。');
      }
      else {
        // A lost upload response is not proof of failure. A later request checks the
        // deployed registry and finishes D1 activation without re-uploading blindly.
        operation.view.status = 'verifying';
        operation.view.error = { code: 'deployment_unconfirmed', message: '正在核对 Worker 的实际发布结果，原安装尚未切换。' }; await save(operation);
        if (error instanceof ExtensionError) await failed(operation, error.code, error.message);
        else if (Date.now() - (operation.attemptedAt ?? Date.now()) > 120_000) await failed(operation, 'deployment_unconfirmed', '暂时无法核对云端发布，原安装仍然保留。恢复连接后可重新发起变更。');
      }
    } finally {
      await input.db.prepare('UPDATE worker_plugin_changes SET lease_token = NULL, lease_until = 0 WHERE operation_id = ? AND lease_token = ?').bind(id, lease).run();
    }
  }
  function schedule(id: string) { input.waitUntil(run(id).catch(() => {})); }
  async function enqueue(kind: PluginChange['kind'], installation: { manifest: PluginManifest; revision: string }, expectedGeneration: number | null, files?: ReadonlyMap<string, Uint8Array>) {
    const now = new Date().toISOString();
    const operation: Operation = { view: { operationId: crypto.randomUUID(), kind, pluginId: installation.manifest.id, status: 'queued', createdAt: now, updatedAt: now },
      expectedGeneration, manifest: installation.manifest, revision: installation.revision };
    try {
      await input.db.prepare('INSERT INTO worker_plugin_changes (operation_id, status, document) VALUES (?, ?, ?)')
        .bind(operation.view.operationId, 'queued', JSON.stringify(operation)).run();
    } catch {
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
      schedule(operation.view.operationId);
    } catch { await failed(operation, 'staging_failed', '插件暂存失败，原安装保持可用。'); }
    return operation.view;
  }
  return {
    async install(archive: Uint8Array, signal: AbortSignal): Promise<PluginChange> {
      configured(); const prepared = await readPackage(archive, 'worker', signal);
      const previous = await store.installation(prepared.manifest.id); assertInstallationCandidate(previous, prepared);
      return enqueue('install', { manifest: prepared.manifest, revision: prepared.digest }, previous?.generation ?? null, prepared.files);
    },
    async remove(id: string, signal: AbortSignal): Promise<PluginChange> {
      configured(); signal.throwIfAborted(); const previous = await store.installation(id);
      if (!previous) throw new ExtensionError('missing_plugin', 'Plugin is not installed');
      return enqueue('remove', previous, previous.generation);
    },
    async get(id: string): Promise<PluginChange | null> {
      const operation = await load(id); if (!operation) return null;
      if (!terminal(operation.view)) schedule(id);
      return operation.view;
    }
  };
}
