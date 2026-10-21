import { chmod, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const targets = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'windows-x64': 'x86_64-pc-windows-msvc',
  'macos-x64': 'x86_64-apple-darwin',
  'macos-arm64': 'aarch64-apple-darwin'
} as const;
export type DesktopNativeTarget = keyof typeof targets;
type WindowsToolchain = 'gnu' | 'msvc';

function rustTarget(target: DesktopNativeTarget, windowsToolchain?: WindowsToolchain) {
  if (!(target in targets)) throw new Error(`Supported native targets: ${Object.keys(targets).join(', ')}`);
  return target === 'windows-x64'
    && (windowsToolchain ?? (process.platform === 'win32' ? 'msvc' : 'gnu')) === 'gnu'
    ? 'x86_64-pc-windows-gnu' : targets[target];
}

export async function buildDesktopNative(input: {
  target: DesktopNativeTarget;
  output: string;
  linker?: string;
  windowsToolchain?: WindowsToolchain;
}): Promise<void> {
  const target = rustTarget(input.target, input.windowsToolchain);
  const windowsGnu = target === 'x86_64-pc-windows-gnu';
  const repository = resolve(import.meta.dir, '..');
  const targetDirectory = resolve(repository, 'dist/tools/desktop-native');
  const cachedMingw = resolve(repository, 'dist/tools/mingw/usr/bin/x86_64-w64-mingw32-gcc-posix');
  const linker = input.linker ?? (windowsGnu && await Bun.file(cachedMingw).exists() ? cachedMingw : undefined);
  const linkerEnvironment = linker ? {
    [`CARGO_TARGET_${target.replaceAll('-', '_').toUpperCase()}_LINKER`]: resolve(linker)
  } : {};
  const child = Bun.spawn(['cargo', 'build', '--locked', '--release', '--manifest-path',
    resolve(repository, 'native/desktop/Cargo.toml'), '--target', target, '--target-dir', targetDirectory], {
    cwd: repository, env: { ...process.env, ...linkerEnvironment,
      ...(windowsGnu && linker ? { PATH: `${dirname(linker)}${delimiter}${process.env.PATH ?? ''}` } : {}) },
    stdout: 'inherit', stderr: 'inherit'
  });
  if (await child.exited !== 0) {
    throw new Error(`Native desktop build failed for ${input.target}; use that platform's Rust toolchain and SDK, or configure MinGW and --windows-toolchain gnu / --linker for Windows cross builds.`);
  }
  const output = resolve(input.output);
  await mkdir(dirname(output), { recursive: true });
  await cp(resolve(targetDirectory, target, 'release', input.target === 'windows-x64' ? 'desktop-helper.exe' : 'desktop-helper'), output);
  if (input.target !== 'windows-x64') await chmod(output, 0o755);
  console.log(`Desktop integration helper: ${output}`);
}

/** Copy notices for the locked target graph from Cargo's existing registry cache. */
export async function writeDesktopNativeLicenses(input: {
  target: DesktopNativeTarget;
  outputDirectory: string;
  windowsToolchain?: WindowsToolchain;
}): Promise<void> {
  const target = rustTarget(input.target, input.windowsToolchain);
  const repository = resolve(import.meta.dir, '..');
  const child = Bun.spawn(['cargo', 'metadata', '--locked', '--offline', '--format-version', '1',
    '--manifest-path', resolve(repository, 'native/desktop/Cargo.toml'), '--filter-platform', target], {
    cwd: repository, stdout: 'pipe', stderr: 'pipe'
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
  ]);
  if (code !== 0) throw new Error(`Cannot read the cached native dependency graph: ${stderr.trim()}`);
  const metadata = JSON.parse(stdout) as {
    packages: { id: string; name: string; version: string; license: string | null;
      license_file: string | null; manifest_path: string }[];
    resolve: { root: string; nodes: { id: string; dependencies: string[] }[] };
  };
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const selected = new Set<string>();
  function visit(id: string) {
    if (selected.has(id)) return;
    selected.add(id);
    for (const dependency of nodes.get(id)?.dependencies ?? []) visit(dependency);
  }
  visit(metadata.resolve.root);
  const packages = metadata.packages.filter(item => selected.has(item.id) && item.id !== metadata.resolve.root)
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
  const index: { name: string; version: string; license: string | null; files: string[] }[] = [];
  const output = resolve(input.outputDirectory);
  await mkdir(output, { recursive: true });
  for (const item of packages) {
    const directory = dirname(item.manifest_path);
    const documents = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^(?:licen[cs]es?|copying|notice|authors?|copyright|unlicense)(?:[._-].*)?$/i.test(entry.name))
      .map(entry => ({ name: entry.name, path: join(directory, entry.name) }));
    if (item.license_file && !documents.some(document => document.path === resolve(directory, item.license_file!))) {
      documents.push({ name: 'LICENSE-DECLARED', path: resolve(directory, item.license_file) });
    }
    if (!documents.some(document => /^(?:licen[cs]es?|copying|unlicense)(?:[._-].*)?$/i.test(document.name))) {
      throw new Error(`Cached crate has no license document: ${item.name}@${item.version}`);
    }
    const folder = `${item.name}@${item.version}`;
    await mkdir(join(output, folder), { recursive: true });
    for (const document of documents.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      await writeFile(join(output, folder, document.name), await readFile(document.path));
    }
    index.push({ name: item.name, version: item.version, license: item.license,
      files: documents.map(document => `${folder}/${document.name}`) });
  }
  const runtime = await writeLinkedRuntimeNotices(target, output, repository);
  await writeFile(join(output, 'index.json'), JSON.stringify({ formatVersion: 1, target,
    packages: index, runtime }, null, 2) + '\n');
}

async function writeLinkedRuntimeNotices(target: string, output: string, repository: string) {
  const readRustc = async (args: string[]) => {
    const child = Bun.spawn(['rustc', ...args], { cwd: repository, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ]);
    if (code !== 0) throw new Error(`Cannot locate the native Rust runtime notices: ${stderr.trim()}`);
    return stdout.trim();
  };
  const [sysroot, compiler] = await Promise.all([readRustc(['--print', 'sysroot']), readRustc(['--version'])]);
  const rustDocuments = join(sysroot, 'share/doc/rust');
  const files: string[] = []; const boundaries: string[] = [];
  const copyExisting = async (source: string, name: string) => {
    if (!await Bun.file(source).exists()) { boundaries.push(`Not present in the installed build materials: ${name}`); return; }
    const destination = join(output, 'runtime', name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination); files.push(`runtime/${name}`);
  };
  // The installed standard-library notice inventory is separate from the much
  // larger compiler/toolchain inventory; only the former is part of this bundle.
  await copyExisting(join(rustDocuments, 'COPYRIGHT-library.html'), 'rust/COPYRIGHT-library.html');
  for (const name of ['MIT.txt', 'Apache-2.0.txt', 'Unicode-3.0.txt', 'BSD-2-Clause.txt', 'LLVM-exception.txt']) {
    await copyExisting(join(rustDocuments, 'licenses', name), `rust/licenses/${name}`);
  }
  if (target.endsWith('-musl')) {
    const available = await readdir(join(rustDocuments, 'licenses')).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    });
    const musl = available.filter(name => /musl/i.test(name));
    for (const name of musl) await copyExisting(join(rustDocuments, 'licenses', name), `musl/${name}`);
    if (!musl.length) boundaries.push('The installed Rust sysroot has no dedicated musl libc copyright document; the Rust standard-library notices are included, without claiming a separate musl notice inventory.');
  }
  if (target === 'x86_64-pc-windows-gnu') {
    const mingwDocuments = join(repository, 'dist/tools/mingw/usr/share/doc');
    await copyExisting(join(mingwDocuments, 'mingw-w64-common/copyright'), 'mingw/CRT-COPYRIGHT.txt');
    await copyExisting(join(mingwDocuments, 'gcc-mingw-w64-base/copyright'), 'mingw/GCC-RUNTIME-COPYRIGHT.txt');
    for (const name of ['GPL-3.0-or-later.txt', 'GCC-exception-3.1.txt']) {
      await copyExisting(join(rustDocuments, 'licenses', name), `mingw/${name}`);
    }
  }
  return { compiler, files, boundaries };
}

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: {
    target: { type: 'string' }, output: { type: 'string' }, linker: { type: 'string' }, 'windows-toolchain': { type: 'string' }
  } });
  const native = `${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`;
  const target = values.target ?? native;
  if (!(target in targets)) throw new Error(`Supported native targets: ${Object.keys(targets).join(', ')}`);
  if (values['windows-toolchain'] && !['gnu', 'msvc'].includes(values['windows-toolchain'])) {
    throw new Error('--windows-toolchain must be gnu or msvc');
  }
  await buildDesktopNative({ target: target as DesktopNativeTarget,
    output: values.output ?? resolve('dist/native', target, target === 'windows-x64' ? 'desktop-helper.exe' : 'desktop-helper'),
    ...(values.linker ? { linker: values.linker } : {}),
    ...(values['windows-toolchain'] ? { windowsToolchain: values['windows-toolchain'] as 'gnu' | 'msvc' } : {}) });
}
