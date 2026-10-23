import { createInstance, type TOptions } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import type { Configuration, DisplayMessage, PluginManifest } from '@musicfs/plugin-api';
import { i18nOptions, resources, resolveLanguage, type Language } from '../i18n';

export const i18n = createInstance();
void i18n.use(LanguageDetector).use(initReactI18next).init({
  ...i18nOptions, resources: structuredClone(resources), detection: { order: ['localStorage', 'navigator'], lookupLocalStorage: 'musicfs.language',
    caches: ['localStorage'], convertDetectedLanguage: resolveLanguage }, react: { useSuspense: false }
});
const pluginNamespaces = new Set<string>();
const configurationNamespaces = new WeakMap<Configuration, string>();
export const currentLanguage = (): Language => resolveLanguage(i18n.resolvedLanguage);
export const pluginName = (manifest: Pick<PluginManifest, 'name' | 'nameTranslations'>) => manifest.nameTranslations?.[currentLanguage()] ?? manifest.name;
export function t(key: string, options: TOptions = {}): string {
  return i18n.t(key, { ns: ['ui', ...pluginNamespaces], ...options }) as string;
}
export function messageText(value: DisplayMessage | string): string {
  if (typeof value === 'string') return t(value);
  return value.translation ? t(value.translation.key, { defaultValue: value.message, ...value.translation.values }) : t(value.message);
}
export function registerPluginTranslations(id: string, configuration: Configuration) {
  const namespace = `plugin.${id}`;
  configurationNamespaces.set(configuration, namespace);
  for (const [language, messages] of Object.entries(configuration.translations ?? {})) {
    i18n.addResourceBundle(language, namespace, messages, true, true);
  }
  if (configuration.translations) pluginNamespaces.add(namespace);
}
export function pluginText(configuration: Configuration, key: string): string {
  const namespace = configurationNamespaces.get(configuration);
  return t(key, namespace ? { ns: [namespace, 'ui'] } : {});
}
/** Translate display annotations only; defaults, enum values and saved data stay intact. */
export function localizedSchema(value: unknown, translate: (key: string) => string = t): unknown {
  if (Array.isArray(value)) return value.map(item => localizedSchema(item, translate));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    ['default', 'const', 'enum', 'examples'].includes(key) ? child
      : ['title', 'description'].includes(key) && typeof child === 'string' ? translate(child) : localizedSchema(child, translate)]));
}
