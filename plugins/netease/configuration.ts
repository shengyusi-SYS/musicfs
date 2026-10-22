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
  return { label: '网易云音乐', quality: 'standard', ...rest, ...(metadataCacheDays === undefined || metadataCacheDays === 365 ? {} : { metadataCacheDays }), audio: audio === undefined ? initial
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
export function metadataCacheExpiry(config: Json, now = Date.now(), maximumDays?: number): number | null {
  const days = object(config).metadataCacheDays ?? 365;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) fail('invalid_config', '音乐资料缓存天数必须是非负整数，0 表示长期保留。');
  const expiry = days === 0 ? null : now + days * 24 * 60 * 60 * 1000;
  return maximumDays === undefined ? expiry : Math.min(expiry ?? Infinity, now + maximumDays * 24 * 60 * 60 * 1000);
}

/** Upgrade the old default once; future explicit short periods remain configurable. */
export function migrateConfig(input: { fromVersion: number; config: Json }): Json {
  if (input.fromVersion !== 1) fail('invalid_config', '不支持此配置版本。');
  const config = normalizeConfig(input.config);
  if (config !== null && typeof config === 'object' && !Array.isArray(config) && config.metadataCacheDays === 7) delete config.metadataCacheDays;
  return config;
}

export function contentConfiguration(config: Json): Json {
  const { metadataCacheDays: _retention, ...content } = object(normalizeConfig(config));
  return content as Json;
}
