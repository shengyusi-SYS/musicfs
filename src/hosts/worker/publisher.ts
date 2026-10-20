import { createClient } from 'cloudflare/tree-shakable';
import { BaseContent } from 'cloudflare/resources/workers/scripts/content';

export type WorkerModule = { name: string; type: 'esm' | 'text' | 'data'; bytes: Uint8Array };
export type WorkerArtifact = { mainModule: string; modules: WorkerModule[] };
export const workerModuleType = (name: string): WorkerModule['type'] => /\.m?js$/i.test(name) ? 'esm' : /\.(json|txt|md)$/i.test(name) ? 'text' : 'data';
const mediaType = (type: WorkerModule['type']) => type === 'esm' ? 'application/javascript+module' : type === 'text' ? 'text/plain' : 'application/octet-stream';

/** Code-only updates leave bindings, secrets, assets and script settings with Cloudflare. */
export function createWorkerPublisher(input: { accountId: string; scriptName: string; apiToken: string; fetcher?: typeof fetch }) {
  const client = createClient({ resources: [BaseContent], apiToken: input.apiToken,
    ...(input.fetcher ? { fetch: input.fetcher } : {}), maxRetries: 0, timeout: 20_000 });
  return {
    async content(signal: AbortSignal): Promise<WorkerArtifact> {
      const response = await client.workers.scripts.content.get(input.scriptName, { account_id: input.accountId },
        { signal, headers: { Accept: 'multipart/form-data' } });
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith('multipart/')) { await response.body?.cancel(); throw new Error('Expected a module Worker deployment'); }
      const headers = new Headers(response.headers);
      headers.set('Content-Type', contentType.replace(/^multipart\/mixed/i, 'multipart/form-data'));
      const form = await new Response(response.body, { headers }).formData();
      const modules: WorkerModule[] = [];
      let mainModule = response.headers.get('cf-worker-main-module-part') ?? 'worker.mjs';
      for (const [name, value] of form.entries()) {
        const part: unknown = value;
        if (typeof part !== 'string' && !(part instanceof Blob)) throw new Error('Invalid Worker module upload part');
        if (name === 'metadata') {
          const metadata: unknown = JSON.parse(typeof part === 'string' ? part : await part.text());
          if (metadata && typeof metadata === 'object' && 'main_module' in metadata && typeof metadata.main_module === 'string') mainModule = metadata.main_module;
          continue;
        }
        // MusicFS builders/publishers assign module types by package filename.
        // Bun's formData() rewrites Blob.type from the filename (e.g. JSON text
        // becomes application/json), so its MIME value cannot recover that type.
        const type = workerModuleType(name);
        if (typeof part === 'string') { modules.push({ name, type, bytes: new TextEncoder().encode(part) }); continue; }
        modules.push({ name, type, bytes: new Uint8Array(await part.arrayBuffer()) });
      }
      if (!modules.some(module => module.name === mainModule) || !modules.some(module => module.name === 'registry.mjs') || !modules.some(module => module.name === 'core.mjs')) throw new Error('The deployed Worker is not a MusicFS module bundle');
      return { mainModule, modules };
    },
    async replace(artifact: WorkerArtifact, signal: AbortSignal): Promise<void> {
      const form = new FormData();
      form.set('metadata', JSON.stringify({ main_module: artifact.mainModule }));
      for (const module of artifact.modules) form.set(module.name, new File([module.bytes.slice().buffer], module.name, { type: mediaType(module.type) }));
      // The SDK's generated v7 multipart encoder expands JSON metadata into bracketed
      // fields. Its public request method accepts native FormData, so keep this one
      // endpoint's documented part names/JSON while retaining SDK auth and errors.
      await client.put(`/accounts/${encodeURIComponent(input.accountId)}/workers/scripts/${encodeURIComponent(input.scriptName)}/content`, {
        body: form, signal, headers: { 'CF-WORKER-MAIN-MODULE-PART': artifact.mainModule }
      });
    }
  };
}
