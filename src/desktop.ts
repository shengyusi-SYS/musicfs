import { dirname, resolve } from 'node:path';
import { defaultDesktopDirectory, launchDesktop, startDesktopBackground } from './hosts/desktop/launcher';
import { reportDesktopStartupFailure } from './hosts/desktop/notifications';
import { desktopHelp, desktopStartupText, hasDesktopSession, parseDesktopArgs } from './hosts/desktop/cli';
import { configureDesktopEntry, desktopEntry } from './hosts/desktop/entry';
import { t } from './hosts/desktop/locale';

declare const MUSICFS_COMPILED: boolean | undefined;

const compiled = typeof MUSICFS_COMPILED !== 'undefined' && MUSICFS_COMPILED;
const args = process.argv.slice(2);
let background = args.includes('--background');
let directory = defaultDesktopDirectory();
const desktopSession = hasDesktopSession();

try {
  const { values, network } = parseDesktopArgs(args);
  if (values.help) { console.log(desktopHelp()); process.exit(0); }
  background = !!values.background;
  if (values.data) directory = resolve(values.data);
  const executableDirectory = dirname(process.execPath);
  const resourcesDirectory = resolve(values.resources ?? (compiled
    ? (process.platform === 'darwin' && executableDirectory.endsWith('/MacOS') ? resolve(executableDirectory, '../Resources') : resolve(executableDirectory, 'resources'))
    : resolve(import.meta.dir, '../dist/desktop-resources')));
  const command = compiled ? [process.execPath] : [process.execPath, import.meta.path];
  const headless = !!values.headless || !!values.foreground || !desktopSession;
  const systemIntegration = !!compiled && !values['no-integration'] && !headless;
  const repeatCommand = [...command, '--data', directory, '--resources', resourcesDirectory, ...(values.language ? ['--language', values.language] : [])];
  const showEntry = async (reused: boolean, foreground = false) => console.log(desktopStartupText({
    entry: await desktopEntry(directory), directory, command: repeatCommand, reused, foreground, platform: process.platform
  }));
  if (values.background || values.foreground) {
    const backend = await startDesktopBackground({ directory, resourcesDirectory, command, systemIntegration, ...(network ? { network } : {}) });
    if (backend) {
      const stop = () => { void backend.close().then(() => process.exit(0)).catch(() => console.error(t('请先关闭正在使用挂载文件的程序，再退出 MusicFS。'))); };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
    }
    if (values.foreground) {
      if (!backend && network) await configureDesktopEntry(directory, network);
      await showEntry(!backend, !!backend);
    }
  } else {
    const result = await launchDesktop({ command, directory, resourcesDirectory, systemIntegration, loginStartup: !!values.autostart,
      ...(network ? { network } : {}), ...(values['no-open'] || headless ? { openBrowser: false } : {}) });
    if (!values.autostart && (headless || values['no-open'])) await showEntry(result.reused);
  }
} catch (error) {
  const message = error instanceof Error ? t(error.message) : t('MusicFS 启动失败。');
  if (background || args.includes('--foreground')) console.error(message);
  else await reportDesktopStartupFailure({ message, directory, showDialog: desktopSession && !args.includes('--headless') && !args.includes('--no-open') });
  process.exitCode = 1;
}
