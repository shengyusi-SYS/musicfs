import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeDeploymentConfig, updateWorkerSource } from '../scripts/update-worker-source';

const template = {
  name: 'musicfs', main: 'dist/worker/worker.mjs', compatibility_date: '2026-07-30', compatibility_flags: ['nodejs_compat'],
  assets: { directory: './dist/web', binding: 'ASSETS', run_worker_first: ['/api/*', '/dav/*'] },
  d1_databases: [{ binding: 'DB', database_name: 'musicfs', database_id: 'placeholder', migrations_dir: 'new/migrations' }],
  secrets: { required: ['ADMIN_TOKEN', 'CF_API_TOKEN'] }, vars: { NEW_DEFAULT: true }, rules: [{ type: 'ESModule' }]
};

test('updates project wiring while retaining provisioned resources and user deployment settings', () => {
  const installed = { ...template, name: 'my-music', account_id: 'my-account', compatibility_date: '2025-01-01',
    compatibility_flags: ['custom-flag'], routes: [{ pattern: 'music.example.com', custom_domain: true }],
    observability: { enabled: false }, triggers: { crons: ['*/5 * * * *'] }, workers_dev: false,
    assets: { ...template.assets, directory: './old-web', html_handling: 'none' },
    vars: { CF_ACCOUNT_ID: 'my-account', EXTRA: 'value' }, secrets: { required: ['ADMIN_TOKEN', 'EXTRA_SECRET'] },
    d1_databases: [{ binding: 'DB', database_name: 'my-db', database_id: 'real-id', migrations_dir: 'old', remote: true },
      { binding: 'ANOTHER', database_id: 'another-id' }] };
  const merged = mergeDeploymentConfig(installed, template);
  expect(merged.name).toBe('my-music'); expect(merged.account_id).toBe('my-account');
  expect(merged.routes).toEqual(installed.routes); expect(merged.triggers).toEqual(installed.triggers);
  expect(merged.observability).toEqual(installed.observability); expect(merged.workers_dev).toBe(false);
  expect(merged.compatibility_date).toBe(template.compatibility_date);
  expect(merged.compatibility_flags).toEqual(['nodejs_compat', 'custom-flag']);
  expect(merged.assets).toEqual({ ...template.assets, html_handling: 'none' });
  expect(merged.d1_databases).toEqual([{ ...installed.d1_databases[0], migrations_dir: 'new/migrations' }, installed.d1_databases[1]]);
  expect(merged.vars).toEqual({ NEW_DEFAULT: true, ...installed.vars });
  expect(merged.secrets.required).toEqual(['ADMIN_TOKEN', 'CF_API_TOKEN', 'EXTRA_SECRET']);
});

test('updates an independent clone, removes obsolete source, preserves automation, and skips repeated or older releases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-source-update-'));
  const source = join(directory, 'source'); const target = join(directory, 'target');
  async function write(root: string, name: string, text: string) { await Bun.write(join(root, name), text); }
  async function checkout(root: string, version: string) {
    await mkdir(root, { recursive: true });
    await write(root, 'package.json', JSON.stringify({ version }));
    await write(root, 'wrangler.jsonc', JSON.stringify(template));
    const result = Bun.spawnSync(['git', 'init', '--quiet', root]); expect(result.exitCode).toBe(0);
  }
  function stage(root: string) { expect(Bun.spawnSync(['git', '-C', root, 'add', '.']).exitCode).toBe(0); }
  try {
    await checkout(source, '0.1.1'); await checkout(target, '0.1.0');
    await write(source, 'src/new.ts', 'new program'); await write(target, 'src/obsolete.ts', 'old program');
    await write(source, '.github/workflows/release.yml', 'upstream workflow');
    await write(target, '.github/workflows/update-musicfs.yml', 'user update workflow');
    await write(target, '.dev.vars', 'fixture-secret');
    await write(target, 'wrangler.jsonc', '// provisioned\n' + JSON.stringify({ ...template, name: 'my-music' }));
    stage(source); stage(target);
    expect(await updateWorkerSource(source, target, '0.1.1')).toEqual({ changed: true, previous: '0.1.0', version: '0.1.1' });
    expect(await Bun.file(join(target, 'src/new.ts')).text()).toBe('new program');
    expect(await Bun.file(join(target, 'src/obsolete.ts')).exists()).toBe(false);
    expect(await Bun.file(join(target, '.github/workflows/update-musicfs.yml')).text()).toBe('user update workflow');
    expect(await Bun.file(join(target, '.github/workflows/release.yml')).exists()).toBe(false);
    expect(await Bun.file(join(target, '.dev.vars')).text()).toBe('fixture-secret');
    expect((await Bun.file(join(target, 'wrangler.jsonc')).json()).name).toBe('my-music');
    expect((await updateWorkerSource(source, target, '0.1.1')).changed).toBe(false);
    await write(source, 'package.json', JSON.stringify({ version: '0.1.0' }));
    expect((await updateWorkerSource(source, target, '0.1.0')).changed).toBe(false);
    await expect(updateWorkerSource(source, target, '0.1.2')).rejects.toThrow('Release tag and package version must match');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
