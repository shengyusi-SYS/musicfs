import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createReleaseIdentity } from './helpers/release-identity';

/** The actual public sources and build tooling, without the MusicFS application or its dependencies. */
export async function buildAuthorKit(): Promise<string> {
  const directory = resolve('dist/plugin-author-kit');
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const files = ['packages/plugin-api/package.json', 'packages/plugin-api/src/index.ts', 'scripts/build-plugin.ts', 'scripts/build-sample.ts',
    'plugins/sample/index.ts', 'plugins/sample/manifest.json', 'plugins/sample/config.schema.json',
    'plugins/sample/generated-config.d.mts', 'plugins/sample/LICENSE.txt', 'plugins/sample/README.md',
    'docs/plugin-authoring.md', 'docs/architecture/plugin-interface.md'];
  if (await Bun.file('LICENSE').exists()) files.push('LICENSE');
  for (const file of files) {
    const destination = join(directory, file); await mkdir(dirname(destination), { recursive: true });
    await cp(file, destination);
  }
  const root = await Bun.file('package.json').json() as { version: string; packageManager: string; license: string;
    dependencies: Record<string, string>; devDependencies: Record<string, string> };
  await Bun.write(join(directory, 'package.json'), JSON.stringify({ name: 'musicfs-plugin-author-kit', private: true, type: 'module',
    version: root.version, packageManager: root.packageManager, license: root.license,
    scripts: { build: 'bun run scripts/build-sample.ts', typecheck: 'tsc --noEmit' },
    dependencies: { '@musicfs/plugin-api': 'file:./packages/plugin-api' }, devDependencies: {
      '@zip.js/zip.js': root.dependencies['@zip.js/zip.js'], ajv: root.devDependencies.ajv,
      typescript: root.devDependencies.typescript, '@types/bun': root.devDependencies['@types/bun']
    } }, null, 2) + '\n');
  await Bun.write(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2023', 'DOM', 'DOM.Iterable'], types: ['bun'],
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true, resolveJsonModule: true, skipLibCheck: true, noEmit: true
  }, include: ['packages', 'plugins', 'scripts'] }, null, 2) + '\n');
  await Bun.write(join(directory, '.gitignore'), 'node_modules/\ndist/\nplugins/sample/generated-config.mjs\n');
  await Bun.write(join(directory, 'README.md'), '# MusicFS 插件作者包\n\n从[作者指南](docs/plugin-authoring.md)开始。\n\n在本目录执行：\n\n```sh\nbun install --frozen-lockfile\nbun run build\nbun run typecheck\n```\n\n修改 `plugins/sample/manifest.json` 的 ID、名称与版本后重新构建；输出为 `dist/plugins/<插件ID>.zip`。把 ZIP 安装到已有 MusicFS，不需要重新编译核心或页面。公开接口由随包的本地 `packages/plugin-api` 提供，尚未发布 npm SDK。\n');
  // A separate minimal lockfile avoids shipping the application's WebUI/SDK dependencies to authors.
  const lock = Bun.spawn([process.execPath, 'install', '--lockfile-only', '--ignore-scripts', '--prefer-offline'], {
    cwd: directory, stdout: 'pipe', stderr: 'pipe'
  });
  const [code, errors] = await Promise.all([lock.exited, new Response(lock.stderr).text()]);
  if (code !== 0) throw new Error(`Could not generate the author kit lockfile: ${errors}`);
  await Bun.write(join(directory, 'release.json'), JSON.stringify({ formatVersion: 1, kind: 'plugin-author-kit',
    identity: await createReleaseIdentity(), bunVersion: Bun.version, generatedAt: new Date().toISOString() }, null, 2) + '\n');
  return directory;
}

if (import.meta.main) console.log(`Plugin author kit: ${await buildAuthorKit()}`);
