import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { createDav } from '../src/transport/dav';
import { libraryFixture } from './helpers/library-fixture';
import sample from '../plugins/sample';

let server: Bun.Server<undefined>; let fixture: Awaited<ReturnType<typeof libraryFixture>>; let origin: string; let metadataCalls = 0; let batches = 0;
const authorization = 'Basic ' + Buffer.from('reader:fixture-password').toString('base64');
const file = '/dav/' + ['实例 & #', '目录 & #', '440 Hz.wav'].map(encodeURIComponent).join('/');
const request = (path: string, init: RequestInit = {}) => fetch(origin + path, { ...init, headers: { Authorization: authorization, ...init.headers } });
beforeAll(async () => {
  fixture = await libraryFixture({ ...sample, stat: (ctx, file) => { metadataCalls++; return sample.stat(ctx, file); } }, { label: '目录 & #' });
  const statMany = fixture.library.files.statMany;
  fixture.library.files.statMany = (...args) => { batches++; return statMany(...args); };
  const app = createDav(fixture.library.files, { username: 'reader', password: 'fixture-password' });
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
  origin = server.url.origin;
});
afterAll(async () => { if (server) await server.stop(true); fixture?.close(); });

describe('shared Fetch read-only DAV over the MusicFS library', () => {
  test('authenticates, advertises actual methods and rejects writes', async () => {
    const unauthenticated = await fetch(origin + '/dav/'); expect(unauthenticated.status).toBe(401); await unauthenticated.body?.cancel();
    const options = await request('/dav/', { method: 'OPTIONS' }); expect(options.status).toBe(200);
    expect(options.headers.get('Allow')).toBe('OPTIONS, PROPFIND, GET, HEAD');
    const write = await request(file, { method: 'PUT', body: 'not allowed' }); expect(write.status).toBe(405); await write.body?.cancel();
  });
  test('PROPFIND encodes special-character paths and respects requested properties', async () => {
    const response = await request('/dav/' + encodeURIComponent('实例 & #') + '/', {
      method: 'PROPFIND', headers: { Depth: '1', 'Content-Type': 'application/xml' },
      body: '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:resourcetype/><D:missing/></D:prop></D:propfind>'
    });
    expect(response.status).toBe(207);
    const xml = await response.text();
    expect(xml).toContain('目录 &amp; #'); expect(xml).toContain(encodeURIComponent('目录 & #')); expect(xml).toContain('404');
  });
  test('PROPFIND names and property names avoid audio metadata probes; content properties return real metadata', async () => {
    const directory = file.slice(0, file.lastIndexOf('/') + 1);
    for (const selection of ['<D:propname/>', '<D:prop><D:displayname/><D:resourcetype/><D:creationdate/><D:getlastmodified/><D:missing/></D:prop>']) {
      const before = metadataCalls; const previousBatches = batches;
      const response = await request(directory, { method: 'PROPFIND', headers: { Depth: '1', 'Content-Type': 'application/xml' },
        body: `<D:propfind xmlns:D="DAV:">${selection}</D:propfind>` });
      expect(response.status).toBe(207); const xml = await response.text();
      expect(xml).toContain(encodeURIComponent('440 Hz.wav')); expect(metadataCalls).toBe(before); expect(batches).toBe(previousBatches);
      if (selection === '<D:propname/>') { expect(xml).toContain('<D:getcontentlength/>'); expect(xml).not.toContain('16044'); }
      else expect(xml).toContain('404 Not Found');
    }
    for (const body of ['', '<D:propfind xmlns:D="DAV:"><D:prop><D:getcontentlength/><D:getcontenttype/><D:getetag/></D:prop></D:propfind>']) {
      const before = metadataCalls; const previousBatches = batches;
      const response = await request(directory, { method: 'PROPFIND', headers: { Depth: '1', 'Content-Type': 'application/xml' }, body });
      expect(response.status).toBe(207); const xml = await response.text();
      expect(xml).toContain('<D:getcontentlength>16044</D:getcontentlength>'); expect(xml).toContain('audio/wav');
      expect(metadataCalls).toBe(before); expect(batches).toBe(previousBatches + 1);
    }
  });
  test('allprop lazily requests one batch for many prepared files and preserves legacy stat fallback', async () => {
    for (const prepared of [true, false]) {
      let probes = 0; let batchCalls = 0;
      const entries = Array.from({ length: 12 }, (_, index) => ({ kind: 'file' as const, entryId: `tone-${index}`, name: `${index}.wav`, fileRef: 'tone',
        ...(prepared ? { info: { contentId: `prepared-${index}`, size: index + 100, mediaType: 'audio/wav' } } : {}) }));
      const local = await libraryFixture({ ...sample, list: async () => ({ ok: true, value: { items: entries } }),
        stat: (ctx, ref) => { probes++; return sample.stat(ctx, ref); } }, { label: '目录 & #' });
      try {
        const statMany = local.library.files.statMany;
        local.library.files.statMany = (...args) => { batchCalls++; return statMany(...args); };
        const app = createDav(local.library.files, { username: 'reader', password: 'fixture-password' });
        const response = await app.request('http://fixture' + file.slice(0, file.lastIndexOf('/') + 1), {
          method: 'PROPFIND', headers: { Authorization: authorization, Depth: '1' }
        });
        expect(response.status).toBe(207); const xml = await response.text();
        expect(batchCalls).toBe(1); expect(probes).toBe(prepared ? 0 : entries.length);
        expect(xml).toContain(`<D:getcontentlength>${prepared ? 111 : 16044}</D:getcontentlength>`);
      } finally { local.close(); }
    }
  });
  test('HEAD and full GET report and return the real 16044-byte WAV', async () => {
    const head = await request(file, { method: 'HEAD' }); expect(head.status).toBe(200); expect(head.headers.get('Content-Length')).toBe('16044');
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const full = await request(file); expect(full.status).toBe(200);
    const bytes = new Uint8Array(await full.arrayBuffer()); expect(bytes.length).toBe(16044); expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');
  });
  test('single, suffix, open-ended and unsatisfiable ranges match actual bytes', async () => {
    const all = new Uint8Array(await (await request(file)).arrayBuffer());
    for (const [range, start, end] of [['bytes=0-3', 0, 3], ['bytes=1000-2024', 1000, 2024], ['bytes=-16', 16028, 16043], ['bytes=16040-', 16040, 16043]] as const) {
      const response = await request(file, { headers: { Range: range } }); expect(response.status).toBe(206);
      expect(response.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/16044`);
      const length = response.headers.get('Content-Length');
      // Bun may use chunked framing for a Web Stream; a present length must still be exact.
      if (length !== null) expect(length).toBe(String(end - start + 1));
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(all.slice(start, end + 1));
    }
    const tooLarge = await request(file, { headers: { Range: 'bytes=16044-' } }); expect(tooLarge.status).toBe(416);
    expect(tooLarge.headers.get('Content-Range')).toBe('bytes */16044'); await tooLarge.body?.cancel();
  });
  test('an oversized suffix range selects the whole file', async () => {
    const response = await request(file, { headers: { Range: 'bytes=-999999' } });
    expect(response.status).toBe(206); expect((await response.arrayBuffer()).byteLength).toBe(16044);
  });
  test('unknown range units and multipart requests are explicitly ignored', async () => {
    for (const range of ['items=0-3', 'bytes=0-3,100-103']) {
      const response = await request(file, { headers: { Range: range } });
      expect(response.status).toBe(200); expect((await response.arrayBuffer()).byteLength).toBe(16044);
    }
  });
  test('conditional validators preserve If-Range semantics', async () => {
    const head = await request(file, { method: 'HEAD' }); const etag = head.headers.get('ETag')!;
    const match = await request(file, { headers: { Range: 'bytes=0-3', 'If-Range': etag } }); expect(match.status).toBe(206); expect(await match.text()).toBe('RIFF');
    const stale = await request(file, { headers: { Range: 'bytes=0-3', 'If-Range': '"stale"' } }); expect(stale.status).toBe(200); expect((await stale.arrayBuffer()).byteLength).toBe(16044);
    const unchanged = await request(file, { headers: { 'If-None-Match': etag } }); expect(unchanged.status).toBe(304); expect((await unchanged.arrayBuffer()).byteLength).toBe(0);
    const failed = await request(file, { headers: { 'If-Match': '"stale"' } }); expect(failed.status).toBe(412); await failed.body?.cancel();
  });
  test('finite depth and XML namespace rules are explicit', async () => {
    const infinite = await request('/dav/', { method: 'PROPFIND', headers: { Depth: 'infinity' } }); expect(infinite.status).toBe(403); expect(await infinite.text()).toContain('propfind-finite-depth');
    const invalid = await request('/dav/', { method: 'PROPFIND', headers: { Depth: '0' }, body: '<not-xml' }); expect(invalid.status).toBe(400); await invalid.body?.cancel();
    const foreign = await request('/dav/', { method: 'PROPFIND', headers: { Depth: '0', 'Content-Type': 'application/xml' },
      body: '<D:propfind xmlns:D="DAV:" xmlns:X="urn:fixture"><D:prop><D:displayname/><X:displayname/></D:prop></D:propfind>' });
    expect(foreign.status).toBe(207); const xml = await foreign.text(); expect(xml).toContain('urn:fixture'); expect(xml).toContain('404 Not Found'); expect(xml).toContain('200 OK');
  });
});
