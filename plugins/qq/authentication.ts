import type { AuthAction, AuthStep } from '@musicfs/plugin-api';
import { fail, object, QqFailure, type QqClient, type QqState } from './client';

async function qrImage(client: QqClient, value: unknown): Promise<string> {
  if (typeof value !== 'string') fail('temporary', 'QQ 未返回有效二维码。');
  if (/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length <= 350_000) return value;
  const url = new URL(value);
  if (url.protocol !== 'https:') fail('temporary', 'QQ 返回了不支持的二维码地址。');
  const response = await client.ctx.fetch(url, { signal: client.ctx.signal });
  const type = response.headers.get('content-type')?.split(';')[0]?.trim();
  if (!response.ok || !response.body || type !== 'image/png' && type !== 'image/jpeg') { await response.body?.cancel(); fail('temporary', 'QQ 二维码图片暂时无法取得。'); }
  const reader = response.body.getReader(); let length = 0; let binary = '';
  try {
    while (true) { const next = await reader.read(); if (next.done) break;
      if ((length += next.value.length) > 256 * 1024) fail('temporary', 'QQ 二维码图片过大。');
      for (const byte of next.value) binary += String.fromCharCode(byte);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return `data:${type};base64,${btoa(binary)}`;
}

async function complete(client: QqClient): Promise<AuthStep> {
  const status = await client.call('/login/status');
  const profile = object(object(status.data).profile);
  if (!Object.keys(profile).length) fail('needs_auth', 'QQ 未确认有效账号，请重新开始扫码。');
  const name = [profile.nickname, profile.nick, profile.name].find(value => typeof value === 'string' && value.length > 0);
  client.update({ ...client.state, pending: null, accountName: typeof name === 'string' ? name.slice(0, 500) : null });
  return { kind: 'complete', ...(client.state.accountName ? { accountName: client.state.accountName } : {}) };
}

export async function authenticate(client: QqClient, action: AuthAction): Promise<AuthStep> {
  if (action.kind === 'start') {
    const config = object(client.ctx.config); const channel = config.channel === 'wechat' ? 'wechat' : 'qq';
    const created = await client.call('/login/qr/key', { channel });
    const key = object(created.data).unikey;
    if (typeof key !== 'string' || !key) fail('temporary', 'QQ 未返回有效授权挑战。');
    const image = await client.call('/login/qr/create', { key });
    const pending: NonNullable<QqState['pending']> = { id: crypto.randomUUID(), key, channel, expiresAt: new Date(Date.now() + 120_000).toISOString(), qrImage: await qrImage(client, object(image.data).qrimg), confirmed: false };
    client.update({ ...client.state, pending });
    return { kind: 'waiting', challengeId: pending.id, expiresAt: pending.expiresAt, qrImage: pending.qrImage,
      message: channel === 'wechat' ? '请使用微信扫描二维码，并在手机上确认授权。' : '请使用手机 QQ 扫描二维码，并在手机上确认授权。' };
  }
  const pending = client.state.pending;
  if (!pending || pending.id !== action.challengeId) fail('invalid_config', 'QQ 授权挑战已变化，请重新开始。');
  if (action.kind === 'cancel') {
    // Discard the local challenge even if upstream cancellation is temporarily unavailable.
    try { await client.call('/login/qr/cancel', { key: pending.key }, 'POST'); } catch { client.ctx.signal.throwIfAborted(); }
    client.update({ ...client.state, pending: null }); return { kind: 'cancelled' };
  }
  if (action.kind !== 'poll') fail('not_supported', '此 QQ 授权方式只需扫码，不需要提交表单。');
  if (Date.parse(pending.expiresAt) <= Date.now()) { client.update({ ...client.state, pending: null }); return { kind: 'expired', message: 'QQ 二维码已过期，请重新开始。' }; }
  if (pending.confirmed && client.state.token) return complete(client);
  const checked = await client.call('/login/qr/check', { key: pending.key });
  if (checked.code === 803) {
    const cookie = typeof checked.cookie === 'string' ? checked.cookie : '';
    const token = cookie.split(';').find(item => item.trim().startsWith('qqmusic_session='))?.trim().slice('qqmusic_session='.length);
    if (!token) fail('temporary', 'QQ 已确认扫码，但未返回有效授权，请重试。');
    client.update({ ...client.state, token, pending: { ...pending, confirmed: true } });
    return complete(client);
  }
  if (checked.code === 800) {
    if (typeof checked.message === 'string' && /expired/i.test(checked.message)) { client.update({ ...client.state, pending: null }); return { kind: 'expired', message: 'QQ 二维码已过期，请重新开始。' }; }
    const retry = typeof checked.retryAfterMs === 'number' ? Math.ceil(checked.retryAfterMs / 1000) : undefined;
    throw new QqFailure({ kind: retry ? 'rate_limited' : 'temporary', message: 'QQ 授权检查暂未成功，请稍后重试或重新开始。', ...(retry ? { retryAfterSeconds: retry } : {}) });
  }
  if (checked.code !== 801 && checked.code !== 802) fail('temporary', 'QQ 返回了无法识别的授权状态。');
  return { kind: 'waiting', challengeId: pending.id, expiresAt: pending.expiresAt, qrImage: pending.qrImage,
    message: checked.code === 802 ? '二维码已扫描，请在手机上确认授权。' : pending.channel === 'wechat' ? '请使用微信扫描二维码。' : '请使用手机 QQ 扫描二维码。' };
}
