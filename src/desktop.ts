import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultDesktopDirectory, launchDesktop, startDesktopBackground } from './hosts/desktop/launcher';
import { reportDesktopStartupFailure } from './hosts/desktop/notifications';

declare const MUSICFS_COMPILED: boolean | undefined;

const compiled = typeof MUSICFS_COMPILED !== 'undefined' && MUSICFS_COMPILED;
const args = process.argv.slice(2);
let background = args.includes('--background');
let directory = defaultDesktopDirectory();

try {
  const { values } = parseArgs({ args, strict: true, options: {
    background: { type: 'boolean' }, 'no-open': { type: 'boolean' }, data: { type: 'string' }, resources: { type: 'string' }
  } });
  background = !!values.background;
  if (values.data) directory = resolve(values.data);
  const executableDirectory = dirname(process.execPath);
  const resourcesDirectory = resolve(values.resources ?? (compiled
    ? (process.platform === 'darwin' && executableDirectory.endsWith('/MacOS') ? resolve(executableDirectory, '../Resources') : resolve(executableDirectory, 'resources'))
    : resolve(import.meta.dir, '../dist/desktop-resources')));
  if (values.background) {
    const backend = await startDesktopBackground({ ...(values.data ? { directory: values.data } : {}), resourcesDirectory });
    if (backend) {
      const stop = () => { void backend.close().then(() => process.exit(0)).catch(() => console.error('MusicFS: close active files before quitting the background.')); };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
    }
  } else {
    await launchDesktop({ command: compiled ? [process.execPath] : [process.execPath, import.meta.path], resourcesDirectory,
      ...(values.data ? { directory: values.data } : {}), openBrowser: !values['no-open'] });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'MusicFS desktop startup failed.';
  if (background) console.error(message);
  else await reportDesktopStartupFailure({ message, directory, showDialog: !args.includes('--no-open') });
  process.exitCode = 1;
}
