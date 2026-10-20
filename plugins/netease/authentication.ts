import type { AuthAction, AuthStep } from '@musicfs/plugin-api';
import { endpoints } from './generated-upstream.mjs';
import { fail, object, type NeteaseClient } from './client';

function complete(client: NeteaseClient): AuthStep {
  if (!client.jar.getCookiesSync('https://music.163.com').some(cookie => cookie.key === 'MUSIC_U' && cookie.value)) fail('temporary', '网易云已确认扫码，但尚未返回有效会话。');
  client.update({ ...client.state, accountId: null, accountName: null, pending: null });
  return { kind: 'complete' };
}
function waiting(client: NeteaseClient, scanned = false): AuthStep {
  const pending = client.state.pending!;
  const url = new URL('https://music.163.com/login'); url.searchParams.set('codekey', pending.key);
  return { kind: 'waiting', challengeId: pending.id, expiresAt: pending.expiresAt, qrCode: url.href, url: url.href,
    message: scanned ? '二维码已扫描，请在手机上确认授权。' : '请使用网易云音乐 App 扫描二维码，并在手机上确认授权。' };
}
export async function authenticate(client: NeteaseClient, action: AuthAction): Promise<AuthStep> {
  if (action.kind === 'start') {
    const result = await client.call(endpoints.qrKey);
    const key = object(result.data).unikey;
    if (typeof key !== 'string' || key.length < 1 || key.length > 2000) fail('temporary', '网易云未返回有效扫码挑战。');
    client.update({ ...client.state, pending: { id: crypto.randomUUID(), key, expiresAt: new Date(Date.now() + 120_000).toISOString(), confirmed: false } });
    return waiting(client);
  }
  const pending = client.state.pending;
  if (!pending || pending.id !== action.challengeId) fail('invalid_config', '网易云授权挑战已变化，请重新开始。');
  if (action.kind === 'cancel') { client.update({ ...client.state, pending: null }); return { kind: 'cancelled' }; }
  if (action.kind !== 'poll') fail('not_supported', '网易云扫码授权不需要提交表单。');
  if (pending.confirmed) return complete(client);
  if (Date.parse(pending.expiresAt) <= Date.now()) { client.update({ ...client.state, pending: null }); return { kind: 'expired', message: '网易云二维码已过期，请重新开始。' }; }
  const checked = await client.call(endpoints.qrCheck, { key: pending.key });
  if (checked.code === 803) return complete(client);
  if (checked.code === 800) { client.update({ ...client.state, pending: null }); return { kind: 'expired', message: '网易云二维码已过期，请重新开始。' }; }
  if (checked.code !== 801 && checked.code !== 802) fail('temporary', '网易云返回了无法识别的授权状态。');
  return waiting(client, checked.code === 802);
}
