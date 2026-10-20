import type { Json } from '@musicfs/plugin-api';
import { createSealedSessionResolver, deriveAndroidDevice } from '../../plugins/qq/generated-upstream.mjs';

export async function qqSession(account = '123'): Promise<Json> {
  const secret = 'native-sdk-fixture-secret-32-characters-' + account;
  const token = await createSealedSessionResolver({ secrets: { current: secret } }).issue({
    credential: { musicid: account, str_musicid: account, musickey: 'private-native-key-' + account, loginType: 2, encryptUin: 'encrypted-' + account },
    device: await deriveAndroidDevice(secret), expiresAt: Date.now() + 3_600_000
  });
  return { version: 2, secret, token, accountName: null, pending: null, renewAfter: 0 };
}
