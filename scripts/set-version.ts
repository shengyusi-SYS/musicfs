import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { prerelease, valid } from 'semver';

const usage = 'Usage: bun run version:set <version>\nExample: bun run version:set 0.1.0-dev.32';
const guides = [
  { file: 'docs/release.md', summary: (version: string, preview: boolean) => `当前版本为 **${version}**${preview ? '（预发布版）' : ''}。` },
  { file: 'docs/en/release.md', summary: (version: string, preview: boolean) => `Current version: **${version}**${preview ? ' (prerelease)' : ''}.` }
];

/** Prepare all three edits before writing, so document errors leave the version unchanged. */
export async function setVersion(version: string, directory = process.cwd()) {
  if (valid(version) !== version) throw new Error(`Use a full semantic version without a v prefix, for example 0.1.0-dev.32: ${version}`);
  const files = ['package.json', ...guides.map(guide => guide.file)];
  const original = await Promise.all(files.map(file => readFile(resolve(directory, file), 'utf8')));
  const metadata = JSON.parse(original[0]!) as { version: string };
  const previous = metadata.version;
  metadata.version = version;
  const updated = [JSON.stringify(metadata, null, 2) + '\n', ...guides.map((guide, index) => {
    const text = original[index + 1]!;
    const marker = /(<!-- release-version -->\r?\n)[^\r\n]*/;
    if (!marker.test(text)) throw new Error(`Missing release-version marker in ${guide.file}`);
    return text.replace(marker, (_, prefix: string) => prefix + guide.summary(version, prerelease(version) !== null))
      .replace(/(\]\((?:\.\.\/)+dist\/releases\/)([^/)\s]+)\/([^\s)]+)\)/g,
        (_, prefix: string, oldVersion: string, file: string) =>
          `${prefix}${version}/${file.replace(`musicfs-${oldVersion}-`, `musicfs-${version}-`)})`);
  })];
  const changed = files.filter((_, index) => original[index] !== updated[index]);
  await Promise.all(files.map((file, index) => original[index] === updated[index]
    ? Promise.resolve() : writeFile(resolve(directory, file), updated[index]!)));
  return { previous, version, changed };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) console.log(usage);
  else {
    if (positionals.length !== 1) throw new Error(usage);
    const result = await setVersion(positionals[0]!);
    console.log(`${result.previous} → ${result.version}`);
    console.log(result.changed.length ? result.changed.join('\n') : 'Already up to date.');
  }
}
