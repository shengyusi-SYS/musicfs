import { afterEach, expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopHttps } from '../src/hosts/desktop/https';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

async function readTls(url: string, ca: string, method = 'GET', headers: Record<string, string> = {}) {
  // Bun 1.4's BoringSSL client requires CA=true trust anchors. Node/OpenSSL also
  // supports explicitly trusted non-CA self-signed certificates.
  const script = `import { request } from 'node:https';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const { url, ca, method, headers } = JSON.parse(input);
const call = request(url, { ca, method, headers, rejectUnauthorized: true }, response => {
  let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
  response.on('end', () => console.log(JSON.stringify({ status: response.statusCode, headers: response.headers, body })));
});
call.on('error', error => { console.error(error); process.exitCode = 1; }); call.end();`;
  const child = Bun.spawn([Bun.which('node') ?? 'node', '--input-type=module', '-e', script], {
    stdin: Buffer.from(JSON.stringify({ url, ca, method, headers })), stdout: 'pipe', stderr: 'pipe'
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(stderr);
  return JSON.parse(stdout) as { status: number; headers: Record<string, string | string[] | undefined>; body: string };
}

test('local HTTPS exposes only DAV, verifies the leaf certificate, and reopens the same endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-https-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const seen: string[] = [];
  const options = { directory, fetch(request: Request) {
    seen.push(new URL(request.url).pathname);
    if (request.headers.get('Authorization') !== 'Basic test') return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="MusicFS"' } });
    const range = request.headers.get('Range');
    return new Response(request.method === 'HEAD' ? null : range ? 'cde' : 'abcdef', {
      status: range ? 206 : 200, headers: { 'Content-Length': range ? '3' : '6', ...(range ? { 'Content-Range': 'bytes 2-4/6' } : {}) }
    });
  } };
  const first = await createDesktopHttps(options); cleanup.push(() => first.close());
  expect(await first.inspect()).toMatchObject({ enabled: false, davUrl: null, certificate: null,
    ...(process.platform === 'win32' ? {} : { trusted: false, webClient: null }) });
  const enabled = await first.enable();
  const ca = await readFile(join(directory, 'localhost-cert.pem'), 'utf8');
  const certificate = new X509Certificate(ca);
  expect(certificate.ca).toBe(false);
  expect(certificate.subjectAltName).toContain('DNS:localhost');
  expect(certificate.checkIP('127.0.0.1')).toBe('127.0.0.1');
  expect(certificate.checkIP('::1')).toBe('::1');
  expect(enabled.certificate?.fingerprintSha256).toBe(certificate.fingerprint256);
  if (process.platform !== 'win32') expect((await stat(join(directory, 'localhost-key.pem'))).mode & 0o777).toBe(0o600);
  const head = await readTls(enabled.davUrl!, ca, 'HEAD', { Authorization: 'Basic test' });
  expect(head).toMatchObject({ status: 200, body: '', headers: { 'content-length': '6' } });
  const range = await readTls(enabled.davUrl!, ca, 'GET', { Authorization: 'Basic test', Range: 'bytes=2-4' });
  expect(range).toMatchObject({ status: 206, body: 'cde', headers: { 'content-range': 'bytes 2-4/6' } });
  expect((await readTls(enabled.davUrl!, ca)).status).toBe(401);
  expect((await readTls(new URL('/api/instances', enabled.davUrl!).href, ca)).status).toBe(404);
  expect(seen).not.toContain('/api/instances');
  await first.close();
  const reopened = await createDesktopHttps(options); cleanup.push(() => reopened.close());
  expect(await reopened.inspect()).toMatchObject({ enabled: true, davUrl: enabled.davUrl, certificate: enabled.certificate, error: null });
  expect((await readTls(enabled.davUrl!, ca, 'HEAD', { Authorization: 'Basic test' })).status).toBe(200);
  expect(await reopened.disable()).toMatchObject({ enabled: false, davUrl: null, certificate: enabled.certificate });
  expect(JSON.parse(await readFile(join(directory, 'https.json'), 'utf8')).enabled).toBe(false);
});

test('a saved HTTPS port conflict is reported without preventing desktop startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-https-port-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, fetch: () => new Response('dav') };
  const first = await createDesktopHttps(options); cleanup.push(() => first.close());
  const enabled = await first.enable(); await first.close();
  const blocker = Bun.serve({ hostname: '127.0.0.1', port: Number(new URL(enabled.davUrl!).port), fetch: () => new Response('occupied') });
  cleanup.push(async () => { await blocker.stop(true); });
  const reopened = await createDesktopHttps(options); cleanup.push(() => reopened.close());
  expect(await reopened.inspect()).toMatchObject({ enabled: true, davUrl: null, error: expect.any(String) });
});

test('automatic trust has a Windows-only contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-https-trust-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const https = await createDesktopHttps({ directory, platform: 'linux', fetch: () => new Response() });
  cleanup.push(() => https.close());
  await expect(https.trust()).rejects.toMatchObject({ code: 'unsupported_platform' });
});
