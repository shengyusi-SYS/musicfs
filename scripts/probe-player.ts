import assert from 'node:assert/strict';
import { createConnection, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';

// Opt-in acceptance through a real player. URLs, credentials and media names stay private.
const { values } = parseArgs({ args: Bun.argv.slice(2), options: { 'url-file': { type: 'string' }, output: { type: 'string' } } });
assert(values['url-file'], 'Provide --url-file containing one prepared HTTP audio URL');
assert(process.platform !== 'win32', 'This acceptance probe uses Unix IPC; run it on Linux or macOS');
const url = new URL((await Bun.file(values['url-file']).text()).trim());
assert(['http:', 'https:'].includes(url.protocol));
const directory = await mkdtemp(join(tmpdir(), 'musicfs-player-'));
const socketPath = join(directory, 'player.sock');
const log = join(directory, 'player.log');
const args = ['--no-config', '--no-terminal', '--no-video', '--audio-display=no', '--idle=yes', '--pause=yes', '--mute=yes',
  '--cache=no', '--demuxer-readahead-secs=1', '--demuxer-max-bytes=128KiB', '--demuxer-max-back-bytes=0',
  `--input-ipc-server=${socketPath}`];
if (process.env.MUSICFS_PLAYER_AUDIO_OUTPUT) args.push(`--ao=${process.env.MUSICFS_PLAYER_AUDIO_OUTPUT}`);
if (process.env.MUSICFS_PLAYER_AUTHORIZATION) args.push(`--http-header-fields=Authorization: ${process.env.MUSICFS_PLAYER_AUTHORIZATION}`);
const player = Bun.spawn([process.env.MUSICFS_MPV ?? 'mpv', ...args], { stdout: 'ignore', stderr: Bun.file(log) });
let socket: Socket | undefined;
let command: ((...args: unknown[]) => Promise<unknown>) | undefined;
let succeeded = false;
try {
  const deadline = Date.now() + 10_000;
  while (!socket) {
    assert(player.exitCode === null && Date.now() < deadline, `Player IPC did not start; private log: ${log}`);
    socket = await new Promise<Socket | undefined>(resolve => {
      const candidate = createConnection(socketPath);
      candidate.once('connect', () => resolve(candidate));
      candidate.once('error', () => { candidate.destroy(); resolve(undefined); });
    });
    if (!socket) await Bun.sleep(50);
  }
  let sequence = 0; let buffer = ''; let loaded = false; let playbackError = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (event.event === 'file-loaded') loaded = true;
      if (event.event === 'end-file' && event.reason === 'error') playbackError = true;
      const request = pending.get(event.request_id);
      if (request) {
        pending.delete(event.request_id);
        if (event.error === 'success') request.resolve(event.data);
        else request.reject(new Error(`Player command failed: ${event.error}; private log: ${log}`));
      }
    }
  });
  command = (...args) => new Promise((resolve, reject) => {
    const requestId = ++sequence;
    const label = args[0] === 'get_property' ? `get_property ${String(args[1])}` : String(args[0]);
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Player ${label} command timed out; private log: ${log}`)); }, 10_000);
    pending.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket!.write(JSON.stringify({ command: args, request_id: requestId }) + '\n');
  });
  async function until(check: () => Promise<boolean>, message: string, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (!await check()) {
      assert(!playbackError && player.exitCode === null && Date.now() < deadline, `${message}; private log: ${log}`);
      await Bun.sleep(100);
    }
  }
  const property = (name: string) => command!('get_property', name);
  const loadStartedAt = Date.now();
  await command('loadfile', url.href, 'replace');
  await until(async () => loaded, 'Media did not load', 90_000);
  const duration = Number(await property('duration')); assert(duration > 20);
  assert.equal(await property('seekable'), true);
  await command('set_property', 'pause', false);
  await until(async () => Number(await property('time-pos')) > 0.5, 'Playback did not advance');
  const playbackStartedAfterMs = Date.now() - loadStartedAt;
  const audioOutput = String(await property('current-ao'));
  const audio = await property('audio-params');
  assert(audioOutput !== 'undefined' && audioOutput !== 'null' && audioOutput.length > 0, 'Player has no active audio output');
  assert(typeof audio === 'object' && audio !== null && 'samplerate' in audio && Number(audio.samplerate) > 0, 'Player has no decoded audio format');
  const positions = [];
  for (const target of [duration * 0.75, 5, duration * 0.4, duration - 8, 0]) {
    const seekStartedAt = Date.now();
    await command('set_property', 'pause', true);
    await command('seek', target, 'absolute+exact');
    await until(async () => !await property('seeking') && Math.abs(Number(await property('time-pos')) - target) < 1, 'Seek did not settle');
    const settled = Number(await property('time-pos'));
    await command('set_property', 'pause', false);
    await until(async () => Number(await property('time-pos')) > settled + 0.3, 'Playback did not resume after seek');
    positions.push({ targetSeconds: +target.toFixed(3), resumedAtSeconds: +Number(await property('time-pos')).toFixed(3), elapsedMs: Date.now() - seekStartedAt });
  }
  const report = { client: await property('mpv-version'), durationSeconds: duration, audioOutput, audio,
    muted: true, audibilityTested: false, cacheDisabled: true, playbackStartedAfterMs, resumedSeeks: positions };
  if (values.output) await Bun.write(values.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report)); succeeded = true;
} finally {
  if (command && player.exitCode === null) await command('quit').catch(() => {});
  socket?.destroy();
  if (await Promise.race([player.exited.then(() => true), Bun.sleep(2_000).then(() => false)]) === false) { player.kill(); await player.exited; }
  if (succeeded) await rm(directory, { recursive: true, force: true });
}
