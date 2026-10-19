import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Opt-in real-source acceptance probe. Target path and credentials are never printed.
const { values } = parseArgs({ args: Bun.argv.slice(2), options: { 'path-file': { type: 'string' }, save: { type: 'string' } } });
const { MUSICFS_DAV_ORIGIN, MUSICFS_DAV_USERNAME, MUSICFS_DAV_PASSWORD } = process.env;
if (!MUSICFS_DAV_ORIGIN || !MUSICFS_DAV_USERNAME || !MUSICFS_DAV_PASSWORD || !values['path-file']) throw new Error('Set MUSICFS_DAV_ORIGIN/USERNAME/PASSWORD and --path-file with a library file path');
const path = (await Bun.file(values['path-file']).text()).trim();
if (!path.startsWith('/')) throw new Error('The file must contain an absolute library path');
const url = new URL('/dav' + path.split('/').map(encodeURIComponent).join('/'), MUSICFS_DAV_ORIGIN);
const headers = { Authorization: 'Basic ' + btoa(`${MUSICFS_DAV_USERNAME}:${MUSICFS_DAV_PASSWORD}`) };
const request = (init: RequestInit = {}) => fetch(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(90_000) });
const head = await request({ method: 'HEAD' }); assert.equal(head.status, 200);
const size = Number(head.headers.get('content-length')); assert(Number.isSafeInteger(size) && size > 0 && size <= 64 * 1024 ** 2, 'Probe allows files up to 64 MiB');
assert(head.headers.get('content-type')?.startsWith('audio/')); assert.equal((await head.arrayBuffer()).byteLength, 0);
const full = await request(); assert.equal(full.status, 200); assert.equal(full.headers.get('etag'), head.headers.get('etag'));
const bytes = new Uint8Array(await full.arrayBuffer()); assert.equal(bytes.byteLength, size);
const width = Math.min(4096, size); const middle = Math.floor((size - width) / 2);
const checks = [
  { header: `bytes=0-${width - 1}`, start: 0, end: width - 1 },
  { header: `bytes=${middle}-${middle + width - 1}`, start: middle, end: middle + width - 1 },
  { header: `bytes=${size - width}-${size - 1}`, start: size - width, end: size - 1 },
  { header: `bytes=-${width}`, start: size - width, end: size - 1 },
  { header: `bytes=${size - width}-`, start: size - width, end: size - 1 }
];
for (const check of checks) {
  const response = await request({ headers: { Range: check.header } }); assert.equal(response.status, 206);
  assert.equal(response.headers.get('etag'), head.headers.get('etag'));
  assert.equal(response.headers.get('content-range'), `bytes ${check.start}-${check.end}/${size}`);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(check.start, check.end + 1));
}
const invalid = await request({ headers: { Range: `bytes=${size}-` } }); assert.equal(invalid.status, 416);
assert.equal(invalid.headers.get('content-range'), `bytes */${size}`); await invalid.body?.cancel();
if (values.save) await Bun.write(values.save, bytes);
let rclone: { listing: true; full: true; forwardBackwardRanges: number; mountTested: false } | undefined;
if (process.env.MUSICFS_RCLONE) {
  const binary = process.env.MUSICFS_RCLONE; const directory = await mkdtemp(join(tmpdir(), 'musicfs-real-rclone-'));
  const execute = async (args: string[], env = process.env, stdin?: Uint8Array) => {
    const child = Bun.spawn([binary, ...args], { env, ...(stdin ? { stdin } : {}), stdout: 'pipe', stderr: 'pipe' });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).bytes(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`rclone real-source probe failed (${code}): ${error}`);
    return output;
  };
  try {
    const password = new TextDecoder().decode(await execute(['obscure', '-'], process.env, new TextEncoder().encode(MUSICFS_DAV_PASSWORD + '\n'))).trim();
    const config = join(directory, 'rclone.conf'); await Bun.write(config, '');
    const env = { ...process.env, RCLONE_CONFIG_LIVE_TYPE: 'webdav', RCLONE_CONFIG_LIVE_URL: new URL('/dav/', MUSICFS_DAV_ORIGIN).href,
      RCLONE_CONFIG_LIVE_VENDOR: 'other', RCLONE_CONFIG_LIVE_USER: MUSICFS_DAV_USERNAME, RCLONE_CONFIG_LIVE_PASS: password };
    const flags = ['--config', config, '--log-level', 'ERROR', '--timeout', '90s', '--retries', '1', '--low-level-retries', '1'];
    const parts = path.slice(1).split('/'); const filename = parts.pop();
    const listing = JSON.parse(new TextDecoder().decode(await execute(['lsjson', 'live:' + parts.join('/'), '--files-only', ...flags], env))) as { Name: string; Size: number }[];
    assert(listing.some(file => file.Name === filename && file.Size === size));
    assert.deepEqual(await execute(['cat', 'live:' + path.slice(1), ...flags], env), bytes);
    for (const start of [0, middle, size - width, middle, 0]) {
      assert.deepEqual(await execute(['cat', 'live:' + path.slice(1), '--offset', String(start), '--count', String(width), ...flags], env), bytes.slice(start, start + width));
    }
    rclone = { listing: true, full: true, forwardBackwardRanges: 5, mountTested: false };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
console.log(JSON.stringify({ bytes: size, mediaType: head.headers.get('content-type'), sha256: Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join(''),
  head: true, full: true, rangesMatchFull: checks.length, unsatisfiable: 416, ...(rclone ? { rclone } : {}), realClientPlaybackTested: false }));
