import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js/index-native.js';
import { readPackage } from '../src/infrastructure/archives';
import { createReleaseIdentity } from './helpers/release-identity';
import { writeBundleLicenses } from './helpers/bundle-licenses';
import { copyWinFspPrerequisite } from './helpers/winfsp';
import { buildDesktopNative, writeDesktopNativeLicenses } from './build-desktop-native';
import { writePackageDocumentation } from './helpers/documentation';

const targets = {
  'linux-x64': { compile: 'bun-linux-x64', rclone: 'linux-amd64', executable: 'musicfs' },
  'windows-x64': { compile: 'bun-windows-x64', rclone: 'windows-amd64', executable: 'MusicFS.exe' },
  'macos-x64': { compile: 'bun-darwin-x64', rclone: 'osx-amd64', executable: 'MusicFS' },
  'macos-arm64': { compile: 'bun-darwin-arm64', rclone: 'osx-arm64', executable: 'MusicFS' }
} as const;
type Target = keyof typeof targets;
const rcloneVersion = 'v1.75.2';
const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: {
  target: { type: 'string' }, targets: { type: 'string' }, all: { type: 'boolean' }, 'skip-web': { type: 'boolean' }, runtime: { type: 'string' }
} });
const native = `${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`;
if ([values.target !== undefined, values.targets !== undefined, !!values.all].filter(Boolean).length > 1) throw new Error('Choose --target, --targets or --all.');
const selected = values.all ? Object.keys(targets) as Target[] : values.targets ? values.targets.split(',').map(value => value.trim()) : [values.target ?? native];
if (!selected.length || new Set(selected).size !== selected.length || selected.some(target => !(target in targets))) throw new Error(`Supported targets: ${Object.keys(targets).join(', ')}`);
if (values.runtime !== undefined && (!values.runtime.trim() || selected.length !== 1)) throw new Error('Supply --runtime with one target; build each target with its matching Bun executable.');
const runtimeExecutable = values.runtime === undefined ? undefined : resolve(values.runtime);
if (runtimeExecutable && !await Bun.file(runtimeExecutable).exists()) throw new Error('The selected Bun runtime executable does not exist.');
const runtime = runtimeExecutable ? { kind: 'explicit' as const,
  sha256: new Bun.CryptoHasher('sha256').update(await Bun.file(runtimeExecutable).arrayBuffer()).digest('hex') } : { kind: 'default' as const };

async function run(script: string) {
  const child = Bun.spawn([process.execPath, 'run', script], { stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`${script} failed`);
}
if (!values['skip-web']) await run('build:web');
if (!await Bun.file('dist/web/index.html').exists()) throw new Error('Build the shared WebUI before desktop packaging');
await run('build:sample'); await run('build:qq'); await run('build:netease');
const pluginInputs = [['org.musicfs.sample', 'dist/plugins/org.musicfs.sample.zip'], ['org.musicfs.qq', 'dist/plugins/org.musicfs.qq.zip'],
  ['org.musicfs.netease', 'dist/netease/org.musicfs.netease.zip']] as const;
const identity = await createReleaseIdentity(await Promise.all(pluginInputs.map(async ([, path]) =>
  readPackage(new Uint8Array(await Bun.file(path).arrayBuffer()), 'desktop', new AbortController().signal))), 'dist/web');
const runtimeMaterialsDirectory = resolve('third-party', `bun-${Bun.version}`);
const runtimeMaterials = JSON.parse(await readFile(join(runtimeMaterialsDirectory, 'index.json'), 'utf8')) as {
  bunVersion: string; bunRevision: string; components: { documents: { file: string; sha256: string }[] }[];
};
if (runtimeMaterials.bunVersion !== Bun.version || runtimeMaterials.bunRevision !== Bun.revision) throw new Error('Bun runtime materials must match the fixed compiler revision.');
for (const component of runtimeMaterials.components) for (const document of component.documents) {
  const hash = new Bun.CryptoHasher('sha256').update(await Bun.file(join(runtimeMaterialsDirectory, document.file)).arrayBuffer()).digest('hex');
  if (hash !== document.sha256) throw new Error(`Bun runtime document checksum mismatch: ${document.file}`);
}

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
  const helper = join(resources, selectedTarget === 'windows-x64' ? 'desktop-helper.exe' : 'desktop-helper');
  await buildDesktopNative({ target: selectedTarget, output: helper });
  if (selectedTarget === 'windows-x64') await copyWinFspPrerequisite(resources);
  const result = await Bun.build({ entrypoints: ['src/desktop.ts'], minify: true, metafile: true, define: { MUSICFS_COMPILED: 'true' },
    compile: { target: target.compile, outfile: executable, ...(runtimeExecutable ? { executablePath: runtimeExecutable } : {}),
      ...(selectedTarget === 'windows-x64' ? { windows: { hideConsole: true } } : {}) } });
  if (!result.success) throw new AggregateError(result.logs, `Desktop compilation failed for ${selectedTarget}`);
  if (macos) await writeFile(join(releaseDirectory, 'MusicFS.app/Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>MusicFS</string><key>CFBundleIdentifier</key><string>org.musicfs.desktop</string><key>CFBundleName</key><string>MusicFS</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${identity.version.split('-')[0]}</string><key>LSUIElement</key><true/></dict></plist>\n`);
  const plugins = join(releaseDirectory, 'plugins'); await mkdir(plugins, { recursive: true });
  for (const [id, source] of pluginInputs) await cp(source, join(plugins, `${id}.zip`));
  await writePackageDocumentation(releaseDirectory, 'desktop');
  if (await Bun.file('LICENSE').exists()) await cp('LICENSE', join(releaseDirectory, 'LICENSE'));
  await cp('package.json', join(releaseDirectory, 'dependencies.json')); await cp('bun.lock', join(releaseDirectory, 'bun.lock'));
  const licenses = join(releaseDirectory, 'licenses');
  await writeDesktopNativeLicenses({ target: selectedTarget, outputDirectory: join(licenses, 'desktop-helper') });
  await writeBundleLicenses(result.metafile, join(licenses, 'core'));
  await cp('dist/web/THIRD_PARTY_LICENSES.md', join(licenses, 'WebUI.md'));
  await cp(`third-party/bun-${Bun.version}-LICENSE.md`, join(licenses, `bun-${Bun.version}-LICENSE.md`));
  await cp(runtimeMaterialsDirectory, join(licenses, 'bun-runtime'), { recursive: true });
  await cp('third-party/README.md', join(licenses, 'README.md'));
  await writeFile(join(releaseDirectory, 'release.json'), JSON.stringify({ target: selectedTarget, version: identity.version, rclone: rcloneVersion,
    identity, bunVersion: Bun.version, runtime, entrypoint: 'src/desktop.ts',
    desktopHelper: { file: helper.slice(releaseDirectory.length + 1), sha256: new Bun.CryptoHasher('sha256').update(await Bun.file(helper).arrayBuffer()).digest('hex') },
    executable: executable.slice(releaseDirectory.length + 1), generatedAt: new Date().toISOString(), targetRuntimeVerified: false,
    executableSha256: new Bun.CryptoHasher('sha256').update(await Bun.file(executable).arrayBuffer()).digest('hex') }, null, 2) + '\n');
  console.log(`Desktop artifact: ${releaseDirectory} (target runtime and system mounting require separate verification)`);
}
