import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

type Audience = 'desktop' | 'worker' | 'author';

/** Preserve source-relative guide paths; advanced references point to the source package. */
export async function writePackageDocumentation(directory: string, audience: Audience) {
  const guides = audience === 'author'
    ? ['plugin-authoring', 'architecture/plugin-interface', 'architecture/i18n']
    : ['user-guide', 'clients', 'desktop', 'headless', 'worker'];
  const english = audience === 'author' ? ['plugin-authoring', 'plugin-interface'] : guides;
  const files = [...guides.map(name => `docs/${name}.md`), ...english.map(name => `docs/en/${name}.md`)];
  for (const file of files) {
    const destination = join(directory, file);
    await mkdir(dirname(destination), { recursive: true });
    await cp(file, destination);
  }
  for (const file of files) {
    const destination = join(directory, file);
    const english = file.startsWith('docs/en/');
    const content = (await readFile(destination, 'utf8')).replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (link, label: string, target: string) => {
      if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('#')) return link;
      const path = decodeURIComponent(target.split('#')[0]!);
      if (existsSync(resolve(dirname(destination), path))) return link;
      const sourcePath = relative(process.cwd(), resolve(dirname(file), path)).replaceAll('\\', '/');
      return english ? `${label} (source package: \`${sourcePath}\`)` : `${label}（源码包：\`${sourcePath}\`）`;
    });
    await writeFile(destination, content);
  }
  const title = audience === 'author' ? 'MusicFS 插件作者包' : audience === 'worker' ? 'MusicFS Worker' : 'MusicFS';
  const guide = audience === 'author' ? 'plugin-authoring' : audience === 'worker' ? 'worker' : 'user-guide';
  const commands = audience === 'author' ? '\n```sh\nbun install --frozen-lockfile\nbun run build\nbun run typecheck\n```\n' : '';
  await writeFile(join(directory, 'README.md'), `# ${title}\n\n> 本项目仅是转换适配工具，不提供任何会员权益或版权内容\n>\n> 开发中，测试和兼容性、性能、成本优化待完善，欢迎反馈\n\n[English](README.en.md)\n\n从[使用${audience === 'author' ? '与开发' : ''}指南](docs/${guide}.md)开始。${commands}\n完整开发资料见同版本源码包。\n`);
  await writeFile(join(directory, 'README.en.md'), `# ${audience === 'author' ? 'MusicFS plugin author kit' : title}\n\n> This project is only a conversion and adaptation tool. It does not provide membership benefits or copyrighted content.\n>\n> In development. Testing, compatibility, performance and cost optimization need further work. Feedback is welcome.\n\n[简体中文](README.md)\n\nStart with the [${audience === 'author' ? 'author' : audience === 'worker' ? 'deployment' : 'user'} guide](docs/en/${guide}.md).${commands}\nComplete development documentation is in the matching source package.\n`);
  if (audience === 'worker') {
    await writeFile(join(directory, 'WORKER.md'), '# Worker\n\n[部署与升级](docs/worker.md) · [Deployment and upgrades](docs/en/worker.md)\n');
  }
}
