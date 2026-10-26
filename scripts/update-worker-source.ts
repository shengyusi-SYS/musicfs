import { copyFile, mkdir, rm, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseConfigFileTextToJson, flattenDiagnosticMessageText } from 'typescript';
import { gt, valid } from 'semver';

type Config = Record<string, any>;

/** Project-owned execution settings advance; installation-owned resources stay in place. */
export function mergeDeploymentConfig(current: Config, template: Config): Config {
  const merged = { ...template, ...current };
  for (const key of ['main', 'no_bundle', 'find_additional_modules', 'compatibility_date', 'rules']) {
    if (key in template) merged[key] = template[key];
  }
  merged.compatibility_flags = [...new Set([...(template.compatibility_flags ?? []), ...(current.compatibility_flags ?? [])])];
  merged.assets = { ...template.assets, ...current.assets, directory: template.assets.directory,
    binding: template.assets.binding, run_worker_first: template.assets.run_worker_first };
  merged.vars = { ...template.vars, ...current.vars };
  merged.secrets = { ...template.secrets, ...current.secrets,
    required: [...new Set([...(template.secrets?.required ?? []), ...(current.secrets?.required ?? [])])] };
  merged.d1_databases = (template.d1_databases ?? []).map((database: Config) => {
    const existing = current.d1_databases?.find((item: Config) => item.binding === database.binding);
    return { ...database, ...existing, migrations_dir: database.migrations_dir };
  });
  for (const database of current.d1_databases ?? []) {
    if (!merged.d1_databases.some((item: Config) => item.binding === database.binding)) merged.d1_databases.push(database);
  }
  return merged;
}

function git(directory: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', directory, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
}
async function config(directory: string): Promise<Config> {
  const result = parseConfigFileTextToJson('wrangler.jsonc', await Bun.file(resolve(directory, 'wrangler.jsonc')).text());
  if (result.error) throw new Error(flattenDiagnosticMessageText(result.error.messageText, '\n'));
  return result.config;
}

export async function updateWorkerSource(source: string, target: string, version: string) {
  source = resolve(source); target = resolve(target);
  if (source === target) throw new Error('Source and deployment checkout must be separate');
  const next = await Bun.file(resolve(source, 'package.json')).json();
  const previous = await Bun.file(resolve(target, 'package.json')).json();
  if (!valid(version) || next.version !== version) throw new Error('Release tag and package version must match');
  if (!valid(previous.version)) throw new Error('Cannot read installed source version');
  if (!gt(version, previous.version)) return { changed: false, previous: previous.version, version };
  const merged = mergeDeploymentConfig(await config(target), await config(source));
  // Keep repository automation and local deployment files. The PR reviews all application changes.
  const managed = (path: string) => !path.startsWith('.github/') && path !== 'wrangler.jsonc'
    && !/^\.(?:env|dev\.vars)(?:\.|$)/.test(path);
  const modes = new Map(git(source, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    return [entry.slice(tab + 1), entry.slice(0, 6)] as const;
  }));
  const incoming = new Set([...modes.keys()].filter(managed));
  const existing = git(target, ['ls-files', '-z']).split('\0').filter(Boolean).filter(managed);
  for (const file of existing) if (!incoming.has(file)) await rm(resolve(target, file), { force: true });
  for (const file of incoming) {
    const destination = resolve(target, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(source, file), destination);
    await chmod(destination, modes.get(file) === '100755' ? 0o755 : 0o644);
  }
  await Bun.write(resolve(target, 'wrangler.jsonc'), JSON.stringify(merged, null, 2) + '\n');
  return { changed: true, previous: previous.version, version };
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
    source: { type: 'string' }, target: { type: 'string' }, version: { type: 'string' }
  } });
  if (!values.source || !values.target || !values.version) throw new Error('Use --source RELEASE_CHECKOUT --target DEPLOYMENT_CHECKOUT --version VERSION');
  console.log(JSON.stringify(await updateWorkerSource(values.source, values.target, values.version)));
}
