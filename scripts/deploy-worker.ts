import { cp, mkdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { flattenDiagnosticMessageText, parseConfigFileTextToJson } from 'typescript';
import { buildWorker, type WorkerBundle } from './build-worker';
import { buildWorkerUpgrade, type UpgradeConfig } from './build-worker-upgrade';
import { directoryDigest } from './helpers/release-identity';

const wrangler = [process.execPath, 'x', 'wrangler@4.119.0'];
const initialPlugins = ['dist/plugins/org.musicfs.sample.zip', 'dist/plugins/org.musicfs.qq.zip', 'dist/netease/org.musicfs.netease.zip'];

async function readConfiguration(path: string): Promise<UpgradeConfig> {
  const parsed = parseConfigFileTextToJson(path, await Bun.file(path).text());
  if (parsed.error) throw new Error(flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  return parsed.config as UpgradeConfig;
}

/** Keep the template's provisioned resources and the live installation's executable plugins. */
export async function prepareWorkerDeployment(input: {
  config?: string; out?: string; accountId: string; apiToken: string; fetcher?: typeof fetch; pluginArchives?: string[];
}): Promise<{ mode: 'initial' | 'upgrade'; config: string; bundle: WorkerBundle }> {
  const sourcePath = resolve(input.config ?? 'wrangler.jsonc'); const directory = resolve(input.out ?? 'dist/worker');
  const source = await readConfiguration(sourcePath);
  if (!source.name || !source.assets) throw new Error('The source Wrangler configuration must specify name and assets.');
  let bundle: WorkerBundle; let mode: 'initial' | 'upgrade' = 'upgrade';
  try {
    bundle = await buildWorkerUpgrade({ config: sourcePath, out: directory, accountId: input.accountId, apiToken: input.apiToken,
      ...(input.fetcher ? { fetcher: input.fetcher } : {}) });
  } catch (error) {
    // A missing Worker is a first deployment. Auth/network failures must not reset an existing registry.
    if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error;
    mode = 'initial';
    bundle = await buildWorker({ directory, pluginArchives: input.pluginArchives ?? initialPlugins });
  }
  // Browser-only users can install the bundled examples without a local build or a separate release download.
  const downloads = resolve(directory, 'web/plugin-packages'); await mkdir(downloads, { recursive: true });
  for (const archive of input.pluginArchives ?? initialPlugins) await cp(archive, resolve(downloads, basename(archive)));
  bundle.identity.webDigest = await directoryDigest(resolve(directory, 'web'));
  await Bun.write(resolve(directory, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
  const generated = await Bun.file(resolve(directory, 'wrangler.jsonc')).json() as Record<string, unknown>;
  const config = resolve(directory, 'wrangler.jsonc');
  const databases = source.d1_databases as { binding: string; migrations_dir?: string }[] | undefined;
  await Bun.write(config, JSON.stringify({ ...source, account_id: input.accountId,
    main: bundle.mainModule, no_bundle: true, find_additional_modules: true, rules: generated.rules,
    assets: { ...source.assets, directory: './web' },
    d1_databases: databases?.map(database => database.binding === 'DB' ? { ...database, migrations_dir: 'migrations' } : database),
    vars: { ...source.vars, CF_ACCOUNT_ID: input.accountId, CF_WORKER_NAME: source.name }
  }, null, 2) + '\n');
  return { mode, config, bundle };
}

async function command(args: string[], capture = false): Promise<string> {
  const child = Bun.spawn([...wrangler, ...args], { stdout: capture ? 'pipe' : 'inherit', stderr: capture ? 'pipe' : 'inherit' });
  const [code, output, errors] = await Promise.all([child.exited,
    capture ? new Response(child.stdout).text() : '', capture ? new Response(child.stderr).text() : '']);
  if (code !== 0) throw new Error(`Wrangler ${args[0]} failed${errors ? ': ' + errors.trim() : ''}`);
  return output;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: {
    config: { type: 'string' }, 'secrets-file': { type: 'string' }, 'dry-run': { type: 'boolean' }
  } });
  const source = values.config ?? 'wrangler.jsonc'; const config = await readConfiguration(source);
  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? config.account_id as string | undefined;
  if (!accountId) {
    const identity = JSON.parse(await command(['whoami', '--json', '--config', source], true)) as { accounts: { id: string }[] };
    if (identity.accounts.length !== 1) throw new Error('Set CLOUDFLARE_ACCOUNT_ID to select the account for this deployment.');
    accountId = identity.accounts[0]!.id;
  }
  const credentials = JSON.parse(await command(['auth', 'token', '--json', '--config', source], true)) as { token?: string };
  if (!credentials.token) throw new Error('Use wrangler login or set CLOUDFLARE_API_TOKEN.');
  const prepared = await prepareWorkerDeployment({ config: source, accountId, apiToken: credentials.token });
  console.log(`MusicFS ${prepared.mode}: ${config.name}`);
  if (!values['dry-run']) await command(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', prepared.config]);
  await command(['deploy', '--config', prepared.config, '--keep-vars', '--autoconfig=false',
    ...(values['secrets-file'] ? ['--secrets-file', resolve(values['secrets-file'])] : []),
    ...(values['dry-run'] ? ['--dry-run'] : [])]);
}
