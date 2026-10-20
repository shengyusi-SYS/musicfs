import { expect, test } from 'bun:test';
import type { AuthStep, SourcePlugin } from '@musicfs/plugin-api';
import { createQqPlugin } from '../plugins/qq';
import netease from '../plugins/netease';
import qqManifest from '../plugins/qq/manifest.json';
import neteaseManifest from '../plugins/netease/manifest.json';
import { createSealedSessionResolver, deriveAndroidDevice } from '../plugins/qq/generated-upstream.mjs';
import { createSources, type Authentication } from '../src/core/sources';
import { createExtensions, parseManifest, type PluginRegistry } from '../src/core/extensions';
import { createLibrary } from '../src/core/library';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import { createManagementApi } from '../src/transport/http';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzEAAAAASUVORK5CYII=';

for (const source of ['qq', 'netease'] as const) {
  test(`${source} formal authentication completes before optional profile work and content can retry after the QR deadline`, async () => {
    let profileUnavailable = true; let profileCalls = 0; let qrChecks = 0;
    const profile = () => {
      profileCalls++;
      return profileUnavailable ? Response.json({}, { status: 503 }) : Response.json({ code: 200,
        ...(source === 'qq' ? { data: { profile: { nickname: 'fixture' } } } : { profile: { userId: 42, nickname: 'fixture' } }) });
    };
    const plugin: SourcePlugin = source === 'netease' ? netease : createQqPlugin(async (request, env) => {
      const path = new URL(request.url).pathname;
      if (path === '/login/qr/key') return Response.json({ data: { unikey: 'fixture-qr' } });
      if (path === '/login/qr/create') return Response.json({ data: { qrimg: png } });
      if (path === '/login/qr/check') {
        qrChecks++; const secret = env!.QQ_SESSION_SECRET!;
        const token = await createSealedSessionResolver({ secrets: { current: secret } }).issue({
          credential: { musicid: '42', str_musicid: '42', musickey: 'private-fixture-key', loginType: 6 },
          device: await deriveAndroidDevice(secret), expiresAt: Date.now() + 3 * 86_400_000 });
        return Response.json({ code: 803, cookie: `qqmusic_session=${token}` });
      }
      if (path === '/login/status') return profile();
      throw new Error('Unexpected QQ fixture request');
    });
    const transport = (async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname.replace(/^\/(weapi|eapi)\//, '/api/');
      if (path === '/api/login/qrcode/unikey') return Response.json({ code: 200, unikey: 'fixture-qr' });
      if (path === '/api/login/qrcode/client/login') {
        qrChecks++;
        return Response.json({ code: 803 }, { headers: { 'Set-Cookie': 'MUSIC_U=private-fixture-cookie; Domain=.music.163.com; Path=/; Secure' } });
      }
      if (path === '/api/w/nuser/account/get') return profile();
      if (path === '/api/user/playlist') {
        expect(new Headers(init?.headers).get('Cookie')).toContain('MUSIC_U=private-fixture-cookie');
        return Response.json({ code: 200, more: false, playlist: [{ id: 9, userId: 42, specialType: 0, name: 'fixture collection' }] });
      }
      throw new Error('Unexpected NetEase fixture request');
    }) as typeof fetch;
    const store = openSqlite(':memory:');
    try {
      const manifest = parseManifest(source === 'qq' ? qqManifest : neteaseManifest, 'desktop');
      const installed = store.activate(manifest, 'a'.repeat(64), null);
      const registry: PluginRegistry = { get: async () => ({ ...installed, module: plugin }),
        isCurrent: async (id, revision, generation) => {
          const current = store.installation(id); return current?.status === 'active' && current.revision === revision && current.generation === generation;
        } };
      let now = Date.now();
      const sources = createSources(store, registry, transport, () => now);
      const extensions = createExtensions(store, async () => {});
      const api = createManagementApi({ host: 'desktop', adminToken: 'fixture-admin', sources, library: createLibrary(sources, store),
        extensions, remove: id => extensions.remove(id), maxPackageBytes: 100_000,
        install: async () => { throw new Error('Not part of authentication completion'); } });
      const call = (path: string, value?: unknown) => api.request('http://fixture/api' + path, {
        headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' },
        ...(value === undefined ? {} : { method: 'POST', body: JSON.stringify(value) }) });
      const created = await call('/instances', { pluginId: manifest.id, name: 'fixture instance', config: {} }); expect(created.status).toBe(201);
      const id = (await created.json() as { value: { id: string } }).value.id;
      const started = await call(`/instances/${id}/authentication`, { kind: 'start' }); expect(started.status).toBe(200);
      const auth = (await started.json() as { value: Authentication }).value;
      const step = auth.step as Extract<AuthStep, { kind: 'waiting' }>; expect(step.kind).toBe('waiting');
      now = Date.parse(step.expiresAt) - 1_000;
      const completed = await call(`/instances/${id}/authentication`, { kind: 'poll', operationId: auth.operationId, challengeId: step.challengeId });
      expect(completed.status).toBe(200); const publicResult = await completed.text();
      expect(JSON.parse(publicResult)).toMatchObject({ ok: true, value: { step: { kind: 'complete' } } });
      expect(publicResult).not.toContain('private-fixture'); expect(profileCalls).toBe(0); expect(qrChecks).toBe(1);
      const credential = JSON.stringify(store.capture(id)!.privateState);
      expect(credential).not.toBe('null'); expect(store.capture(id)!.privateState).toMatchObject({ pending: null });

      now = Date.parse(step.expiresAt) + 1_000;
      const restored = await call(`/instances/${id}/authentication`); expect(restored.status).toBe(200);
      expect(await restored.json()).toMatchObject({ operationId: auth.operationId, step: { kind: 'complete' } });
      expect(await sources.roots(id, new AbortController().signal)).toMatchObject({ ok: false, error: { kind: 'temporary' } });
      expect(JSON.stringify(store.capture(id)!.privateState)).toBe(credential);
      expect((await sources.authentication(id))!.step?.kind).toBe('complete');

      profileUnavailable = false;
      expect(await sources.roots(id, new AbortController().signal)).toMatchObject({ ok: true, value: { items: expect.arrayContaining([expect.objectContaining({ sourceId: 'created' })]) } });
      if (source === 'netease') {
        expect(await sources.list(id, 'created', new AbortController().signal)).toMatchObject({ ok: true, value: { items: [expect.objectContaining({ name: 'fixture collection' })] } });
        expect(store.capture(id)!.privateState).toMatchObject({ accountId: '42' });
      }
      expect(qrChecks).toBe(1);
    } finally { store.close(); }
  });
}
