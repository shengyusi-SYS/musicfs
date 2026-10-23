import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import en from '../src/i18n/locales/en.json';
import zh from '../src/i18n/locales/zh-CN.json';

const problems: string[] = [];
const placeholders = (text: string) => [...text.matchAll(/\{\{\s*([\w]+)(?:,[^}]+)?\s*\}\}/g)].map(match => match[1]).sort().join(',');
for (const key of new Set([...Object.keys(en), ...Object.keys(zh)])) {
  const english = (en as Record<string, string>)[key], chinese = (zh as Record<string, string>)[key];
  if (!english || !chinese) problems.push(`Missing translation: ${key}`);
  else if (placeholders(english) !== placeholders(chinese)) problems.push(`Different placeholders: ${key}`);
}
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (/\.(ts|tsx)$/.test(path)) result.push(path);
  }
  return result;
}
for (const path of [...await files('src/web'), ...await files('src/hosts/desktop'), 'src/desktop.ts']) {
  const source = await readFile(path, 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 't' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const key = node.arguments[0].text;
      if (!Object.hasOwn(en, key)) problems.push(`${path}: missing message ${key}`);
    }
    if (!path.endsWith('/language-switch.tsx')) {
      if (ts.isJsxText(node) && /\p{Script=Han}/u.test(node.text)) problems.push(`${path}: untranslated JSX text ${node.text.trim()}`);
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /\p{Script=Han}/u.test(node.text)) {
        const parent = node.parent;
        const messageKey = ts.isCallExpression(parent) && parent.expression.getText(file) === 't' && parent.arguments[0] === node
          || ts.isPropertyAssignment(parent) && parent.name.getText(file) === 'key' && Object.hasOwn(en, node.text);
        if (!messageKey) problems.push(`${path}: untranslated string ${node.text}`);
      }
      if (ts.isTemplateExpression(node) && /\p{Script=Han}/u.test(node.head.text + node.templateSpans.map(span => span.literal.text).join('')))
        problems.push(`${path}: untranslated template ${node.getText(file)}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}
for (const plugin of ['sample', 'netease', 'qq']) {
  const schema: unknown = JSON.parse(await readFile(`plugins/${plugin}/config.schema.json`, 'utf8'));
  const translations = JSON.parse(await readFile(`plugins/${plugin}/translations.json`, 'utf8')) as Record<string, Record<string, string>>;
  function annotations(value: unknown) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['default', 'const', 'enum', 'examples'].includes(key)) continue;
      if (['title', 'description'].includes(key) && typeof child === 'string' && /\p{Script=Han}/u.test(child) && !translations.en?.[child])
        problems.push(`${plugin}: missing English schema text ${child}`);
      else annotations(child);
    }
  }
  annotations(schema);
  for (const messages of Object.values(translations)) for (const [key, value] of Object.entries(messages))
    if (placeholders(key) !== placeholders(value)) problems.push(`${plugin}: different placeholders ${key}`);
}
if (problems.length) throw new Error(problems.join('\n'));
console.log(`i18n: ${Object.keys(en).length} Chinese/English messages checked; no hardcoded UI Chinese.`);
