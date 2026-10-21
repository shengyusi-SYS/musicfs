import type { Json } from '@musicfs/plugin-api';
import validate from './generated-config.mjs';
import { fail, object } from './client';

export const qualities = ['hires', 'lossless', 'exhigh', 'standard'] as const;
export type Quality = typeof qualities[number];
export type AudioPolicy = { mode: 'single' | 'multiple'; qualities: Quality[]; missingQuality: 'hide' | 'fallback' };
export const labels: Record<Quality, string> = { hires: 'Hi-Res', lossless: '无损', exhigh: '极高', standard: '标准' };

/** The original quality stays the single-mode setting; multiple targets are independent. */
export function normalizeConfig(candidate: Json): Json {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
  const { audio, metadataCacheDays, ...rest } = candidate;
  const initial = { mode: 'single', qualities: ['standard'], missingQuality: 'hide' };
  return { label: '网易云音乐', quality: 'standard', ...rest, ...(metadataCacheDays === undefined || metadataCacheDays === 7 ? {} : { metadataCacheDays }), audio: audio === undefined ? initial
    : audio !== null && typeof audio === 'object' && !Array.isArray(audio) ? { ...initial, ...audio } : audio };
}
export function audioPolicy(config: Json): AudioPolicy {
  const normalized = normalizeConfig(config);
  if (!validate(normalized)) fail('invalid_config', '网易云音质配置无效，请检查此实例的配置。');
  const value = object(normalized); const policy = value.audio as AudioPolicy;
  return { ...policy, qualities: policy.mode === 'single' ? [value.quality as Quality] : [...policy.qualities] };
}
export function lowerQualities(quality: Quality): Quality[] { return qualities.slice(qualities.indexOf(quality) + 1); }

/** Read the default without adding fields to existing saved configurations. */
export function metadataCacheExpiry(config: Json, now = Date.now()): number | null {
  const days = object(config).metadataCacheDays ?? 7;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) fail('invalid_config', '音乐资料缓存天数必须是非负整数，0 表示长期保留。');
  return days === 0 ? null : now + days * 24 * 60 * 60 * 1000;
}
