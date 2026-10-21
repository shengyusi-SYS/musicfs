import { createHash } from 'node:crypto';

/** Both supported hosts provide the standard native implementation; the core owns serialization. */
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
