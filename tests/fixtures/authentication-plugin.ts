import type { AuthStep, Json, Outcome, SourcePlugin } from '@musicfs/plugin-api';
import sample from '../../plugins/sample';

/** Deliberately labelled fixture; never presented as a real music-platform login. */
const plugin: SourcePlugin = {
  ...sample,
  configuration: { schema: { type: 'object', additionalProperties: false, required: ['mode'], properties: {
    mode: { type: 'string', title: '测试步骤', oneOf: [{ const: 'input', title: '直接输入' }, { const: 'qr', title: '二维码后输入' }] }
  } } },
  async validateConfig(_ctx, config) {
    return typeof config === 'object' && config !== null && !Array.isArray(config) && ['input', 'qr'].includes(String(config.mode))
      && Object.keys(config).length === 1 ? { ok: true, value: config } : { ok: false, error: { kind: 'invalid_config', message: '选择测试步骤。' } };
  },
  async roots(ctx) {
    const state = object(ctx.privateState);
    if (state.authorized !== true) return { ok: false, error: { kind: 'needs_auth', message: '请先完成测试授权。' } };
    return sample.roots({ ...ctx, config: { label: '测试授权目录' } });
  },
  async authenticate(ctx, action): Promise<Outcome<AuthStep>> {
    const state = object(ctx.privateState);
    if (action.kind === 'cancel') return { ok: true, value: { kind: 'cancelled' }, nextPrivateState: null };
    if (action.kind === 'start') {
      const challengeId = crypto.randomUUID(); const expiresAt = new Date(Date.now() + 120_000).toISOString();
      const next = { challengeId, expiresAt, polls: 0, phase: object(ctx.config).mode === 'qr' ? 'qr' : 'input' };
      return { ok: true, value: next.phase === 'qr' ? qr(next) : input(next), nextPrivateState: next };
    }
    if (state.challengeId !== action.challengeId || typeof state.expiresAt !== 'string') return { ok: false, error: { kind: 'invalid_config', message: '测试挑战不匹配。' } };
    if (Date.parse(state.expiresAt) <= Date.now()) return { ok: true, value: { kind: 'expired', message: '测试授权已过期。' } };
    if (action.kind === 'poll') {
      const next = { challengeId: action.challengeId, expiresAt: state.expiresAt, polls: Number(state.polls ?? 0) + 1, phase: 'qr' };
      return { ok: true, value: next.polls >= 2 ? input(next) : qr(next), nextPrivateState: next };
    }
    if (object(action.input).code !== '123456') return { ok: false, error: { kind: 'invalid_config', message: '测试验证码应为 123456。', fields: [{ path: '/code', message: '请输入测试验证码 123456。' }] }, nextPrivateState: { ...state, attempts: Number(state.attempts ?? 0) + 1 } };
    return { ok: true, value: { kind: 'complete', accountName: '测试账号（非真实平台）' }, nextPrivateState: { authorized: true, token: 'fixture-session-token' } };
  }
};
function object(value: Json): Record<string, Json> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function input(state: { challengeId: string; expiresAt: string }): AuthStep {
  return { kind: 'input', challengeId: state.challengeId, expiresAt: state.expiresAt, message: '仅用于验证通用授权表单。请输入测试验证码 123456。', configuration: {
    schema: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', title: '测试验证码', minLength: 6, maxLength: 6 } } }, ui: { widgets: { '/code': 'password' } }
  } };
}
function qr(state: { challengeId: string; expiresAt: string }): AuthStep {
  return { kind: 'waiting', challengeId: state.challengeId, expiresAt: state.expiresAt, message: '这是测试二维码，自动检查两次后进入输入步骤，无需真实扫码。', qrCode: `musicfs-fixture:${state.challengeId}` };
}

export const fixtureManifest = { formatVersion: 1 as const, id: 'org.musicfs.test.authentication', name: '认证流程测试（非真实音源）', version: '0.1.0', apiRange: '>=0.1.0 <0.2.0',
  hosts: { desktop: 'index.mjs', worker: 'index.mjs' }, configVersion: 1, stateVersion: 1, files: ['index.mjs', 'LICENSE.txt'] };
export default plugin;
