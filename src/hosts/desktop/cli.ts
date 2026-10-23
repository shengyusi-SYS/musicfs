import { t } from './locale';
import { parseArgs } from 'node:util';
import type { DesktopNetworkSettings } from '../../contracts/desktop';
import type { desktopEntry } from './entry';
import { desktopNetworkUpdateSchema } from './network';

export const desktopHelp = () => t('cli.help');

export function hasDesktopSession(platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  return platform === 'linux' ? Boolean(env.DISPLAY || env.WAYLAND_DISPLAY) : true;
}

export function parseDesktopArgs(args: string[]) {
  const { values } = parseArgs({ args, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, language: { type: 'string' }, headless: { type: 'boolean' }, foreground: { type: 'boolean' },
    background: { type: 'boolean' }, 'no-open': { type: 'boolean' }, autostart: { type: 'boolean' }, 'no-integration': { type: 'boolean' },
    data: { type: 'string' }, resources: { type: 'string' },
    'management-access': { type: 'string' }, 'management-port': { type: 'string' }, 'dav-access': { type: 'string' }, 'dav-port': { type: 'string' }
  } });
  if (values.language) {
    if (!['zh-CN', 'zh', 'en'].includes(values.language)) throw new Error(t('请选择 zh-CN 或 en。'));
    process.env.MUSICFS_LANGUAGE = values.language;
  }
  const fields: Record<string, unknown> = {};
  for (const [flag, name] of [['management-access', 'managementAccess'], ['dav-access', 'davAccess'],
    ['management-port', 'managementPort'], ['dav-port', 'davPort']] as const) {
    const value = values[flag];
    if (value !== undefined) fields[name] = flag.endsWith('-port') ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
  }
  let network: Partial<DesktopNetworkSettings> | undefined;
  if (Object.keys(fields).length) {
    const parsed = desktopNetworkUpdateSchema.safeParse(fields);
    if (!parsed.success) throw new Error(t("访问范围须为 local 或 lan，端口须为 0—65535 的整数。运行 --help 查看示例。"));
    network = parsed.data as Partial<DesktopNetworkSettings>;
    if (network.managementPort && network.managementPort === network.davPort) throw new Error(t("管理页面与 WebDAV 需要使用不同端口。"));
  }
  return { values, network };
}

export function desktopStartupText(input: {
  entry: Awaited<ReturnType<typeof desktopEntry>>; directory: string; command: string[];
  reused: boolean; foreground?: boolean; platform?: NodeJS.Platform;
}) {
  const { entry, directory } = input;
  const lines = [`MusicFS ${input.reused ? t("已在运行") : t("已启动")}`, t("数据目录：{{value0}}", { value0: directory }), '', t("管理页面："), ...entry.network.managementUrls.map(url => `  ${url}`),
    'WebDAV:', ...entry.network.davUrls.map(url => `  ${url}`), '', t("登录链接（3 分钟内打开一次）："), `  ${entry.login.url}`];
  const fragment = new URL(entry.login.url).hash;
  for (const address of entry.network.managementUrls) {
    if (new URL(address).hostname !== '127.0.0.1') lines.push(`  ${new URL(fragment, address).href}`);
  }
  if (entry.network.restartRequired) lines.push('', t("有端口被占用，当前使用以上实际地址；可在管理页面调整端口。"));
  if (entry.network.active.managementAccess === 'local') {
    const port = new URL(entry.origin).port;
    lines.push('', t("在另一台电脑访问：在那台电脑的终端运行（替换 SSH 登录地址），保持连接后打开上方登录链接："),
      t("  ssh -N -L {{value0}}:127.0.0.1:{{value1}} <用户名@服务器>", { value0: port, value1: port }));
  }
  const windows = input.platform === 'win32';
  const quote = (value: string) => windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
  const repeat = (windows ? '& ' : '') + input.command.map(quote).join(' ');
  lines.push('', t("以后重新运行以下命令即可获取新登录链接，已有后台和挂载继续使用："), `  ${repeat} --headless`,
    '', input.foreground ? t("Ctrl+C 停止 MusicFS。") : t("后台继续运行；可在管理页「服务操作 → 退出 MusicFS」停止。"));
  return lines.join('\n');
}
