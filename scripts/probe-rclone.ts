import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopService } from '../src/hosts/desktop/service';
import { buildSample } from './build-sample';

const binary = process.env.MUSICFS_RCLONE ?? resolve('dist/tools/rclone-v1.75.2-linux-amd64/rclone');
if (!await Bun.file(binary).exists()) throw new Error('Provide a verified rclone binary with MUSICFS_RCLONE; see docs/development.md');
const directory = await mkdtemp(join(tmpdir(), 'musicfs-rclone-'));
const service = await createDesktopService({ directory, adminToken: 'fixture-admin', dav: { username: 'reader', password: 'fixture-password' } });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: service.app.fetch });
const execute = async (args: string[], env = process.env, stdin?: Uint8Array): Promise<Uint8Array> => {
  const child = Bun.spawn([binary, ...args], { env, ...(stdin ? { stdin } : {}), stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).bytes(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`rclone probe failed (${code}): ${stderr}`);
  return stdout;
};
try {
  const archive = await buildSample();
  const installed = await fetch(new URL('/api/plugins', server.url), { method: 'POST', headers: { Authorization: 'Bearer fixture-admin' }, body: new Uint8Array(archive) });
  assert.equal(installed.status, 201); await installed.body?.cancel();
  const instance = await fetch(new URL('/api/instances', server.url), { method: 'POST', headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ pluginId: 'org.musicfs.sample', name: '实例 & #', config: { label: '目录 & #' } }) });
  assert.equal(instance.status, 201); await instance.body?.cancel();
  const obscured = new TextDecoder().decode(await execute(['obscure', '-'], process.env, new TextEncoder().encode('fixture-password\n'))).trim();
  await Bun.write(join(directory, 'rclone.conf'), '');
  const env = { ...process.env, RCLONE_CONFIG_P0_TYPE: 'webdav', RCLONE_CONFIG_P0_URL: new URL('/dav/', server.url).href,
    RCLONE_CONFIG_P0_VENDOR: 'other', RCLONE_CONFIG_P0_USER: 'reader', RCLONE_CONFIG_P0_PASS: obscured };
  const flags = ['--config', join(directory, 'rclone.conf'), '--log-level', 'ERROR', '--timeout', '10s', '--retries', '1', '--low-level-retries', '1'];
  const listed = JSON.parse(new TextDecoder().decode(await execute(['lsjson', 'p0:', '--recursive', '--files-only', ...flags], env))) as { Path: string; Size: number }[];
  assert.equal(listed.length, 1); assert(listed[0]); assert.equal(listed[0].Path, '实例 & #/目录 & #/440 Hz.wav'); assert.equal(listed[0].Size, 16044);
  const remote = 'p0:' + listed[0].Path;
  const complete = await execute(['cat', remote, ...flags], env); assert.equal(complete.length, 16044); assert.equal(new TextDecoder().decode(complete.slice(0, 4)), 'RIFF');
  for (const [offset, count] of [[0, 4], [1000, 1025], [16028, 16], [1000, 4], [0, 4]] as const) {
    const partial = await execute(['cat', remote, '--offset', String(offset), '--count', String(count), ...flags], env);
    assert.deepEqual(partial, complete.slice(offset, offset + count));
  }
  const version = new TextDecoder().decode(await execute(['version'])).split('\n')[0];
  console.log(JSON.stringify({ client: version, recursiveListing: true, unicodePaths: true, size: 16044, fullRead: true,
    ranges: 'first/middle/tail/backward', mountTested: false }));
} finally { await server.stop(true); service.close(); await rm(directory, { recursive: true, force: true }); }
