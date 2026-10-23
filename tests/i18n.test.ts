import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createTranslations, resolveLanguage } from '../src/i18n';
import { i18n, t, localizedSchema, messageText, registerPluginTranslations, pluginText, pluginName } from '../src/web/i18n';
import { ApiError } from '../src/web/api';
import type { Configuration } from '@musicfs/plugin-api';
import neteaseTranslations from '../plugins/netease/translations.json';
import neteaseSchema from '../plugins/netease/config.schema.json';

test('Chinese and English use independent translators with interpolation, plurals and literal template examples', () => {
  expect(resolveLanguage('zh_TW.UTF-8')).toBe('zh-CN'); expect(resolveLanguage('en-GB')).toBe('en');
  const en = createTranslations('en'), zh = createTranslations('zh-CN');
  expect(en.t('音乐库')).toBe('Library'); expect(zh.t('音乐库')).toBe('音乐库');
  expect(en.t('{{count, number}} 项', { count: 1 })).toBe('1 item');
  expect(en.t('{{count, number}} 项', { count: 4000 })).toBe('4,000 items');
  expect(zh.t('{{count, number}} 项', { count: 1 })).toBe('1 项');
  expect(en.t('移动「{{name}}」', { name: '我的歌单' })).toBe('Move “我的歌单”');
  expect(en.t('条件块示例：{{#album}}[{{album}}] {{/album}} 仅在专辑有值时显示方括号和其中的文字。')).toContain('{{#album}}[{{album}}] {{/album}}');
});

test('language changes update stored errors and plugin forms without translating saved values or template data', async () => {
  const previous = i18n.language;
  const configuration: Configuration = { schema: neteaseSchema, translations: neteaseTranslations };
  const original = JSON.stringify(configuration);
  const error = new ApiError(400, { error: 'invalid_layout', message: '此来源不支持命名字段：unknown',
    translation: { key: '此来源不支持命名字段：{{value0}}', values: { value0: 'unknown' } } });
  try {
    registerPluginTranslations('fixture-netease', configuration);
    await i18n.changeLanguage('en');
    expect(t('请使用网易云音乐 App 扫描二维码，并在手机上确认授权。')).toContain('Scan with the NetEase');
    const custom: Configuration = { schema: {}, translations: { en: { '设置': 'Plugin controls' } } };
    registerPluginTranslations('custom-display', custom);
    expect(pluginText(custom, '设置')).toBe('Plugin controls'); expect(t('设置')).toBe('Settings');
    expect(pluginName({ name: '示例', nameTranslations: { en: 'Example' } })).toBe('Example');
    expect(messageText(error)).toBe('This source does not support naming fields: unknown');
    expect(messageText('WinFsp 已就绪，可直接挂载。')).toBe('WinFsp is ready. You can mount now.');
    const schema = localizedSchema(configuration.schema) as typeof neteaseSchema;
    expect(schema.properties.quality.title).toBe('Single-version quality');
    expect(schema.properties.audio.properties.mode.oneOf[0]!.const).toBe('single');
    expect(schema.properties.label.default).toBe(neteaseSchema.properties.label.default);
    const data = { type: 'object', default: { title: '音乐库', description: '设置' }, const: { title: '音乐库' }, enum: [{ title: '音乐库' }], examples: [{ title: '音乐库' }] };
    expect(localizedSchema(data)).toEqual(data);
    await i18n.changeLanguage('zh-CN');
    expect(messageText(new ApiError(503, null))).toBe('请求失败（503）');
    expect(messageText(error)).toBe('此来源不支持命名字段：unknown');
    expect(messageText('WinFsp is ready. You can mount now.')).toBe('WinFsp 已就绪，可直接挂载。');
    expect(JSON.stringify(configuration)).toBe(original);
  } finally { await i18n.changeLanguage(previous); }
});

test('terminal language is selectable before startup, including headless help', async () => {
  for (const [language, expected] of [['en', 'Usage: musicfs'], ['zh-CN', '用法：musicfs']] as const) {
    const child = Bun.spawn([process.execPath, resolve('src/desktop.ts'), '--language', language, '--help'], { stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(0);
    const output = await new Response(child.stdout).text();
    expect(output).toContain(expected); expect(output).toContain('--language');
    if (language === 'en') expect(output).not.toMatch(/\p{Script=Han}/u);
  }
});
