import { createInstance, type InitOptions } from 'i18next';
import zh from './locales/zh-CN.json';
import en from './locales/en.json';

export type Language = 'zh-CN' | 'en';
// Older stored errors may contain either rendered language. Keep both readable.
const aliases = Object.fromEntries(Object.entries(en).filter(([key]) => key in zh).map(([key, value]) => [value, zh[key as keyof typeof zh]]));
export const resources = { 'zh-CN': { ui: { ...aliases, ...zh } }, en: { ui: { ...Object.fromEntries(Object.values(en).map(value => [value, value])), ...en } } };
export const i18nOptions: InitOptions = {
  resources, supportedLngs: ['zh-CN', 'en'], fallbackLng: 'zh-CN', defaultNS: 'ui', ns: ['ui'],
  keySeparator: false, nsSeparator: false, initAsync: false, returnNull: false,
  interpolation: { escapeValue: false, skipOnVariables: true }
};
export function resolveLanguage(value: string | undefined): Language {
  if (!value || /^(C|POSIX)([.@_-]|$)/i.test(value)) return 'zh-CN';
  return /^zh([.@_-]|$)/i.test(value) ? 'zh-CN' : 'en';
}
export function createTranslations(language: Language) {
  const instance = createInstance();
  void instance.init({ ...i18nOptions, resources: structuredClone(resources), lng: language });
  return instance;
}
