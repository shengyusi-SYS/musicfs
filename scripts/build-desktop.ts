import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js/index-native.js';

const targets = {
  'linux-x64': { compile: 'bun-linux-x64', rclone: 'linux-amd64', executable: 'musicfs' },
  'windows-x64': { compile: 'bun-windows-x64', rclone: 'windows-amd64', executable: 'MusicFS.exe' },
  'macos-x64': { compile: 'bun-darwin-x64', rclone: 'osx-amd64', executable: 'MusicFS' },
  'macos-arm64': { compile: 'bun-darwin-arm64', rclone: 'osx-arm64', executable: 'MusicFS' }
} as const;
type Target = keyof typeof targets;
const rcloneVersion = 'v1.75.2';
const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: {
  target: { type: 'string' }, all: { type: 'boolean' }, 'skip-web': { type: 'boolean' }
} });
const native = `${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`;
const selected = values.all ? Object.keys(targets) as Target[] : [values.target ?? native];
if (selected.some(target => !(target in targets))) throw new Error(`Supported targets: ${Object.keys(targets).join(', ')}`);

async function run(script: string) {
  const child = Bun.spawn([process.execPath, 'run', script], { stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`${script} failed`);
}
if (!values['skip-web']) await run('build:web');
if (!await Bun.file('dist/web/index.html').exists()) throw new Error('Build the shared WebUI before desktop packaging');
await run('build:sample'); await run('build:qq'); await run('build:netease');

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Official artifact fetch failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function rclone(platform: string, resources: string) {
  const name = `rclone-${rcloneVersion}-${platform}`;
  const directory = resolve('dist/tools', name);
  const windows = platform.startsWith('windows'); const binary = windows ? 'rclone.exe' : 'rclone';
  const metadataPath = join(directory, 'release.json');
  // The initial Linux probe already pinned the official release checksum.
  let sha256 = platform === 'linux-amd64' ? '349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702' : '';
  if (!sha256) {
    const checksumPath = resolve('dist/tools', `SHA256SUMS-${rcloneVersion}`);
    if (!await Bun.file(checksumPath).exists()) {
      await mkdir(dirname(checksumPath), { recursive: true });
      await writeFile(checksumPath, await fetchBytes(`https://downloads.rclone.org/${rcloneVersion}/SHA256SUMS`));
    }
    const line = (await readFile(checksumPath, 'utf8')).split('\n').find(line => line.trim().endsWith(`${name}.zip`));
    sha256 = line?.trim().split(/\s+/)[0] ?? '';
    if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new Error(`Official checksum missing for ${name}`);
  }
  const source = `https://downloads.rclone.org/${rcloneVersion}/${name}.zip`;
  let reusable = false;
  if (await Bun.file(metadataPath).exists() && await Bun.file(join(directory, binary)).exists()) {
    const previous = JSON.parse(await readFile(metadataPath, 'utf8')) as { sha256?: string; binarySha256?: string };
    const expectedBinary = previous.binarySha256 ?? (platform === 'linux-amd64' ? 'ed7ab1f17876bb006c3df3949a3044959671afd9112362dacaa5dd1647735bc1' : undefined);
    if (previous.sha256 === sha256 && expectedBinary) {
      reusable = new Bun.CryptoHasher('sha256').update(await Bun.file(join(directory, binary)).arrayBuffer()).digest('hex') === expectedBinary;
      if (reusable && !previous.binarySha256) await writeFile(metadataPath, JSON.stringify({ ...previous, binarySha256: expectedBinary }, null, 2));
    }
  }
  if (!reusable) {
    const archive = await fetchBytes(source);
    if (new Bun.CryptoHasher('sha256').update(archive).digest('hex') !== sha256) throw new Error(`Official rclone checksum mismatch for ${platform}`);
    await mkdir(directory, { recursive: true });
    const reader = new ZipReader(new Uint8ArrayReader(archive), { useWebWorkers: false, useCompressionStream: false, checkSignature: true });
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        if (!entry.directory && [binary, 'README.txt'].some(file => entry.filename === `${name}/${file}`)) {
          await writeFile(join(directory, basename(entry.filename)), await entry.getData(new Uint8ArrayWriter()));
        }
      }
    } finally { await reader.close(); }
    if (!await Bun.file(join(directory, binary)).exists()) throw new Error('Official rclone archive is missing its binary');
    await writeFile(metadataPath, JSON.stringify({ version: rcloneVersion, platform, url: source, sha256,
      binarySha256: new Bun.CryptoHasher('sha256').update(await Bun.file(join(directory, binary)).arrayBuffer()).digest('hex') }, null, 2));
  }
  await cp(join(directory, binary), join(resources, binary));
  if (!windows) await chmod(join(resources, binary), 0o755);
  await cp(metadataPath, join(resources, 'rclone-release.json'));
  if (await Bun.file(join(directory, 'README.txt')).exists()) await cp(join(directory, 'README.txt'), join(resources, 'RCLONE-README.txt'));
}

for (const selectedTarget of selected as Target[]) {
  const target = targets[selectedTarget];
  const releaseDirectory = resolve('dist/desktop', selectedTarget);
  // Only clean the generated target directory, never application state.
  await rm(releaseDirectory, { recursive: true, force: true });
  const macos = selectedTarget.startsWith('macos');
  const executable = macos ? join(releaseDirectory, 'MusicFS.app/Contents/MacOS', target.executable) : join(releaseDirectory, target.executable);
  const resources = macos ? join(releaseDirectory, 'MusicFS.app/Contents/Resources') : join(releaseDirectory, 'resources');
  await mkdir(dirname(executable), { recursive: true }); await mkdir(resources, { recursive: true });
  await cp('dist/web', join(resources, 'web'), { recursive: true });
  await rclone(target.rclone, resources);
  const result = await Bun.build({ entrypoints: ['src/desktop.ts'], minify: true, define: { MUSICFS_COMPILED: 'true' },
    compile: { target: target.compile, outfile: executable, ...(selectedTarget === 'windows-x64' ? { windows: { hideConsole: true } } : {}) } });
  if (!result.success) throw new AggregateError(result.logs, `Desktop compilation failed for ${selectedTarget}`);
  if (macos) await writeFile(join(releaseDirectory, 'MusicFS.app/Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>MusicFS</string><key>CFBundleIdentifier</key><string>org.musicfs.desktop</string><key>CFBundleName</key><string>MusicFS</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.1.0</string><key>LSUIElement</key><true/></dict></plist>\n`);
  const plugins = join(releaseDirectory, 'plugins'); await mkdir(plugins, { recursive: true });
  for (const [id, source] of [['org.musicfs.sample', 'dist/plugins/org.musicfs.sample.zip'], ['org.musicfs.qq', 'dist/plugins/org.musicfs.qq.zip'], ['org.musicfs.netease', 'dist/netease/org.musicfs.netease.zip']]) await cp(source!, join(plugins, `${id}.zip`));
  await cp('docs/desktop.md', join(releaseDirectory, 'DESKTOP.md'));
  await cp('package.json', join(releaseDirectory, 'dependencies.json')); await cp('bun.lock', join(releaseDirectory, 'bun.lock'));
  const licenses = join(releaseDirectory, 'licenses'); await mkdir(licenses, { recursive: true });
  // Keep bundled JS dependency licenses, including transitives, beside the executable.
  for (const name of await readdir('node_modules', { recursive: true })) {
    if (!/(^|\/)(license|licence|copying)(\.[^/]*)?$/i.test(name)) continue;
    const source = join('node_modules', name);
    if ((await Bun.file(source).exists())) { const destination = join(licenses, name); await mkdir(dirname(destination), { recursive: true }); await cp(source, destination); }
  }
  await writeFile(join(releaseDirectory, 'release.json'), JSON.stringify({ target: selectedTarget, version: '0.1.0-dev.0', rclone: rcloneVersion,
    executable: executable.slice(releaseDirectory.length + 1), generatedAt: new Date().toISOString(), targetRuntimeVerified: false,
    executableSha256: new Bun.CryptoHasher('sha256').update(await Bun.file(executable).arrayBuffer()).digest('hex') }, null, 2) + '\n');
  console.log(`Desktop artifact: ${releaseDirectory} (target runtime and system mounting require separate verification)`);
}
