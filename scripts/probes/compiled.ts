import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSample } from '../build-sample';

const archive = await buildSample();
await mkdir('dist/p0', { recursive: true });
const binary = resolve('dist/p0/musicfs-plugin-probe');
const build = await Bun.build({ entrypoints: ['tests/probes/compiled-plugin-host.ts'], compile: { outfile: binary }, minify: true });
if (!build.success) throw new AggregateError(build.logs, 'Compiled host probe build failed');
const directory = await mkdtemp(join(tmpdir(), 'musicfs-compiled-'));
try {
  const archivePath = join(directory, 'sample.zip');
  await Bun.write(archivePath, archive);
  for (const phase of ['install', 'restart']) {
    const child = Bun.spawn([binary], {
      cwd: directory,
      env: { MUSICFS_PROBE_DIRECTORY: join(directory, 'user-data'), ...(phase === 'install' ? { MUSICFS_PROBE_ARCHIVE: archivePath } : {}) },
      stdout: 'pipe', stderr: 'pipe'
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Compiled probe ${phase} failed (${code}): ${stderr}`);
    console.log(stdout.trim());
  }
  console.log('PASS: compiled executable loaded an external prebuilt plugin and external SQLite after process restart, outside the project directory.');
} finally { await rm(directory, { recursive: true, force: true }); }
