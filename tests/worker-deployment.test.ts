import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkerDeployment } from '../scripts/deploy-worker';

test('first deployment retains provisioned resources and custom names and binds migrations to the generated package', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-deployment-'));
  try {
    const source = { name: 'my-music', main: 'dist/worker/worker.mjs', compatibility_date: '2026-07-30',
      assets: { directory: './dist/web', binding: 'ASSETS', run_worker_first: ['/api/*'] },
      d1_databases: [{ binding: 'DB', database_name: 'custom-db', database_id: 'provisioned-db-id', migrations_dir: 'src/migrations' }],
      vars: { EXTRA: 'retained' }, secrets: { required: ['ADMIN_TOKEN'] }, triggers: { crons: [] } };
    const config = join(directory, 'wrangler.jsonc'); await Bun.write(config, JSON.stringify(source));
    let gets = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.method).toBe('GET');
      expect(new URL(request.url).pathname).toContain('/accounts/selected-account/workers/scripts/my-music/content/v2');
      gets++;
      return Response.json({ success: false, errors: [{ code: 10007, message: 'Worker not found' }] }, { status: 404 });
    }) as typeof fetch;
    const result = await prepareWorkerDeployment({ config, out: join(directory, 'dist/worker'),
      accountId: 'selected-account', apiToken: 'fixture-token', fetcher });
    expect(gets).toBe(1); expect(result.mode).toBe('initial');
    const output = await Bun.file(result.config).json();
    expect(output.name).toBe('my-music'); expect(output.account_id).toBe('selected-account');
    expect(output.vars).toEqual({ EXTRA: 'retained', CF_ACCOUNT_ID: 'selected-account', CF_WORKER_NAME: 'my-music' });
    expect(output.d1_databases).toEqual([{ ...source.d1_databases[0], migrations_dir: 'migrations' }]);
    expect(output.assets).toEqual({ ...source.assets, directory: './web' });
    expect(output.secrets).toEqual(source.secrets); expect(output.triggers).toEqual(source.triggers);
    expect(result.bundle.plugins.map(plugin => plugin.manifest.id).sort()).toEqual(['org.musicfs.netease', 'org.musicfs.qq', 'org.musicfs.sample']);
    expect(new Uint8Array(await Bun.file(join(directory, 'dist/worker/web/plugin-packages/org.musicfs.qq.zip')).arrayBuffer()))
      .toEqual(new Uint8Array(await Bun.file('dist/plugins/org.musicfs.qq.zip').arrayBuffer()));
    expect(await Bun.file(join(directory, 'dist/worker/migrations/0007.sql')).exists()).toBe(true);
    expect(await Bun.file(config).json()).toEqual(source);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an authorization failure never falls back to an initial empty registry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-deployment-'));
  try {
    const config = join(directory, 'wrangler.jsonc');
    await Bun.write(config, JSON.stringify({ name: 'existing-music', assets: { directory: './dist/web' } }));
    const fetcher = (async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 })) as typeof fetch;
    await expect(prepareWorkerDeployment({ config, out: join(directory, 'dist/worker'),
      accountId: 'selected-account', apiToken: 'fixture-token', fetcher })).rejects.toMatchObject({ status: 403 });
    expect(await Bun.file(join(directory, 'dist/worker/bundle.json')).exists()).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
