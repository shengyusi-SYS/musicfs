import { createTranslations, resolveLanguage, type Language } from '../../i18n';
import type { TOptions } from 'i18next';

const instances = { 'zh-CN': createTranslations('zh-CN'), en: createTranslations('en') };
export function desktopLanguage(): Language {
  return resolveLanguage(process.env.MUSICFS_LANGUAGE || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG
    || Intl.DateTimeFormat().resolvedOptions().locale);
}
export function t(key: string, options: TOptions = {}): string { return instances[desktopLanguage()].t(key, options) as string; }
