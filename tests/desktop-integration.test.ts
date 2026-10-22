import { expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDesktopBrowser, setDesktopAutostart, startDesktopIntegration } from '../src/hosts/desktop/integration';

test.skipIf(process.platform === 'win32')('desktop bridge passes tray actions, closes the helper and preserves startup arguments', async () => {
  const resources = await mkdtemp(join(tmpdir(), 'musicfs-integration-'));
  const helper = join(resources, 'desktop-helper'); const recorded = join(resources, 'startup.json');
  await Bun.write(helper, `#!${process.execPath}
if (process.argv[2] === 'tray') {
  console.log(JSON.stringify({type:'ready'}));
  console.log(JSON.stringify({type:'action',action:'phone'}));
  process.stdin.resume(); process.stdin.on('end', () => process.exit(0));
} else if (process.argv[2] === 'autostart' || process.argv[2] === 'open-url') {
  let input = ''; for await (const chunk of process.stdin) input += chunk.toString();
  await Bun.write(${JSON.stringify(recorded)}, input);
}
`);
  await chmod(helper, 0o755);
  let integration: Awaited<ReturnType<typeof startDesktopIntegration>> | undefined;
  try {
    let received: () => void;
    const action = new Promise<void>(resolve => { received = resolve; });
    const errors: Error[] = [];
    integration = await startDesktopIntegration({ resourcesDirectory: resources,
      onAction(value) { expect(value).toBe('phone'); received(); }, onError(error) { errors.push(error); } });
    await action;
    await integration.close(); await integration.close();
    expect(errors).toEqual([]);
    const command = ['/home/音乐 Files/MusicFS', '--data', '/home/音乐 Files/data', '--autostart'];
    await setDesktopAutostart({ resourcesDirectory: resources, enabled: true, command });
    expect(JSON.parse(await readFile(recorded, 'utf8'))).toEqual({ enabled: true, command });
    const url = 'http://127.0.0.1:8787/?phone=1#ticket=a-b_%E9%9F%B3%E4%B9%90';
    await openDesktopBrowser({ resourcesDirectory: resources, url });
    expect(JSON.parse(await readFile(recorded, 'utf8'))).toBe(url);
  } finally { await integration?.close(); await rm(resources, { recursive: true, force: true }); }
});

test('missing native helper reports startup failure without leaving a pending integration', async () => {
  const resources = await mkdtemp(join(tmpdir(), 'musicfs-integration-missing-'));
  try {
    await expect(startDesktopIntegration({ resourcesDirectory: resources, onAction() {} })).rejects.toThrow();
  } finally { await rm(resources, { recursive: true, force: true }); }
});
