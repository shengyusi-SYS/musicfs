import type { Json } from '@musicfs/plugin-api';
import validate from './generated-config.mjs';
import { fail, object } from './client';

export const qualities = ['flac', 'ape', '320', '128', 'm4a'] as const;
export type Quality = typeof qualities[number];
export type AudioPolicy = { mode: 'single' | 'multiple'; qualities: Quality[]; missingQuality: 'hide' | 'fallback' };
const defaults: AudioPolicy = { mode: 'single', qualities: ['128'], missingQuality: 'hide' };

export function normalizeConfig(candidate: Json): Json {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
  const audio = candidate.audio;
  const initial = { ...defaults, qualities: [...defaults.qualities] };
  return { label: 'QQ 音乐', channel: 'qq', ...candidate,
    audio: audio === undefined ? initial : audio !== null && typeof audio === 'object' && !Array.isArray(audio)
      ? { ...initial, ...audio } : audio };
}

export function audioPolicy(config: Json): AudioPolicy {
  const normalized = normalizeConfig(config);
  if (!validate(normalized)) fail('invalid_config', 'QQ 音质配置无效，请检查此实例的配置。');
  return object(normalized).audio as AudioPolicy;
}

/** The two lossless encodings are peers, not fallback steps for one another. */
export function lowerQualities(quality: Quality): Quality[] {
  if (quality === 'flac' || quality === 'ape') return ['320', '128', 'm4a'];
  return quality === '320' ? ['128', 'm4a'] : quality === '128' ? ['m4a'] : [];
}
