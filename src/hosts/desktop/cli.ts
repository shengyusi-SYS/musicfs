import { parseArgs } from 'node:util';
import type { DesktopNetworkSettings } from '../../contracts/desktop';
import type { desktopEntry } from './entry';
import { desktopNetworkUpdateSchema } from './network';

export const desktopHelp = `MusicFS — 让在线音乐像本地文件一样使用

用法：musicfs [选项]

  --headless                 无桌面运行，显示访问方法，不启用托盘和桌面自启
  --foreground               在当前终端持续运行；Ctrl+C 停止，可用于服务托管
  --no-open                  不自动打开浏览器
  --data <目录>              指定数据目录；重开时使用相同目录
  --management-access <范围> 管理页面访问范围：local 或 lan
  --management-port <端口>   管理端口；0 自动选择
  --dav-access <范围>        WebDAV 访问范围：local 或 lan
  --dav-port <端口>          WebDAV 端口；0 自动选择
  --no-integration           不启用托盘和桌面自启注册
  -h, --help                 显示帮助

默认后台运行，关闭终端后继续服务；再次运行复用已有后台。
Linux 无图形会话或通过 SSH 启动时，自动使用 headless 模式。
管理页面和 WebDAV 默认仅本机访问，范围与端口分别保存。

示例：
  musicfs --headless
  musicfs --headless --management-access lan --management-port 8787
  musicfs --headless --dav-access lan --dav-port 8788
  musicfs --foreground --data /home/me/.local/share/MusicFS
`;

export function hasDesktopSession(platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  return platform === 'linux' ? Boolean(env.DISPLAY || env.WAYLAND_DISPLAY) : true;
}

export function parseDesktopArgs(args: string[]) {
  const { values } = parseArgs({ args, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, headless: { type: 'boolean' }, foreground: { type: 'boolean' },
    background: { type: 'boolean' }, 'no-open': { type: 'boolean' }, autostart: { type: 'boolean' }, 'no-integration': { type: 'boolean' },
    data: { type: 'string' }, resources: { type: 'string' },
    'management-access': { type: 'string' }, 'management-port': { type: 'string' }, 'dav-access': { type: 'string' }, 'dav-port': { type: 'string' }
  } });
  const fields: Record<string, unknown> = {};
  for (const [flag, name] of [['management-access', 'managementAccess'], ['dav-access', 'davAccess'],
    ['management-port', 'managementPort'], ['dav-port', 'davPort']] as const) {
    const value = values[flag];
    if (value !== undefined) fields[name] = flag.endsWith('-port') ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
  }
  let network: Partial<DesktopNetworkSettings> | undefined;
  if (Object.keys(fields).length) {
    const parsed = desktopNetworkUpdateSchema.safeParse(fields);
    if (!parsed.success) throw new Error('访问范围须为 local 或 lan，端口须为 0—65535 的整数。运行 --help 查看示例。');
    network = parsed.data as Partial<DesktopNetworkSettings>;
    if (network.managementPort && network.managementPort === network.davPort) throw new Error('管理页面与 WebDAV 需要使用不同端口。');
  }
  return { values, network };
}

export function desktopStartupText(input: {
  entry: Awaited<ReturnType<typeof desktopEntry>>; directory: string; command: string[];
  reused: boolean; foreground?: boolean; platform?: NodeJS.Platform;
}) {
  const { entry, directory } = input;
  const lines = [`MusicFS ${input.reused ? '已在运行' : '已启动'}`, `数据目录：${directory}`, '', '管理页面：', ...entry.network.managementUrls.map(url => `  ${url}`),
    'WebDAV：', ...entry.network.davUrls.map(url => `  ${url}`), '', '登录链接（3 分钟内打开一次）：', `  ${entry.login.url}`];
  const fragment = new URL(entry.login.url).hash;
  for (const address of entry.network.managementUrls) {
    if (new URL(address).hostname !== '127.0.0.1') lines.push(`  ${new URL(fragment, address).href}`);
  }
  if (entry.network.restartRequired) lines.push('', '有端口被占用，当前使用以上实际地址；可在管理页面调整端口。');
  if (entry.network.active.managementAccess === 'local') {
    const port = new URL(entry.origin).port;
    lines.push('', '在另一台电脑访问：在那台电脑的终端运行（替换 SSH 登录地址），保持连接后打开上方登录链接：',
      `  ssh -N -L ${port}:127.0.0.1:${port} <用户名@服务器>`);
  }
  const windows = input.platform === 'win32';
  const quote = (value: string) => windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
  const repeat = (windows ? '& ' : '') + input.command.map(quote).join(' ');
  lines.push('', '以后重新运行以下命令即可获取新登录链接，已有后台和挂载继续使用：', `  ${repeat} --headless`,
    '', input.foreground ? 'Ctrl+C 停止 MusicFS。' : '后台继续运行；可在管理页「服务操作 → 退出 MusicFS」停止。');
  return lines.join('\n');
}
