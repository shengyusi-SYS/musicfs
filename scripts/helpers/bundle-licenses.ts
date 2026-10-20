import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sanitize from 'sanitize-filename';

type Package = { name: string; version: string; license: unknown; root: string };
type Document = { name: string; bytes: Uint8Array };
const primaryLicense = /^(?:licen[cs]es?|copying)(?:[._-].*)?$/i;
const noticeDocument = /^(?:licen[cs]es?|copying|notice|authors?|copyright)(?:[._-].*)?$|^third[-_]?party.*(?:licen[cs]e|notice).*$/i;
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

function dependencyInput(input: string): string | null {
  if (input.includes('\0') || input.startsWith('<')) return null;
  const path = input.startsWith('file:') ? fileURLToPath(input) : input;
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !isAbsolute(path)) return null;
  return /(^|\/)node_modules\//.test(path.replaceAll('\\', '/')) ? resolve(path) : null;
}
function dependencyName(input: string): string {
  const tail = input.replaceAll('\\', '/').split('/node_modules/').at(-1)!.split('/');
  return tail[0]?.startsWith('@') ? tail.slice(0, 2).join('/') : tail[0] || 'unknown dependency';
}

/** Collect only actual bundled npm inputs; native runtimes and WebUI have separate release inputs. */
export async function writeBundleLicenses(metafile: Bun.BuildMetafile | undefined, directory: string): Promise<void> {
  if (!metafile) throw new Error('Bundle license collection requires Bun.build({ metafile: true })');
  const metadata = new Map<string, Package | undefined>();
  async function packageAt(root: string): Promise<Package | undefined> {
    if (metadata.has(root)) return metadata.get(root);
    let value: unknown;
    try { value = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); }
    catch (error) { if (!missing(error)) throw new Error(`Cannot read package metadata for ${basename(root)}`); }
    const object = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
    const result = typeof object.name === 'string' && object.name.length > 0 && typeof object.version === 'string' && object.version.length > 0
      ? { name: object.name, version: object.version, license: object.license ?? object.licenses ?? null, root } : undefined;
    metadata.set(root, result); return result;
  }
  const packages = new Map<string, Package>();
  for (const input of Object.keys(metafile.inputs).sort()) {
    const path = dependencyInput(input); if (!path) continue;
    let current = dirname(path); let found: Package | undefined;
    while (basename(current) !== 'node_modules') {
      found = await packageAt(current); if (found) break;
      const parent = dirname(current); if (parent === current) break; current = parent;
    }
    if (!found) throw new Error(`Cannot locate named/versioned package metadata for ${dependencyName(path)}`);
    const key = `${found.name}@${found.version}`;
    if (!packages.has(key)) packages.set(key, found);
  }

  const prepared: { package: Package; folder: string; documents: Document[] }[] = [];
  const absent: string[] = []; const folders = new Map<string, string>();
  for (const [key, item] of [...packages].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const folder = sanitize(`${item.name.replaceAll('/', '+')}@${item.version}`, { replacement: '_' });
    if (!folder || folders.has(folder)) throw new Error(`Cannot allocate a portable license directory for ${key}`);
    folders.set(folder, key);
    const documents: Document[] = [];
    for (const name of (await readdir(item.root)).filter(name => noticeDocument.test(name)).sort()) {
      const source = join(item.root, name); if (!(await stat(source)).isFile()) continue;
      documents.push({ name, bytes: new Uint8Array(await readFile(source)) });
    }
    if (!documents.some(document => primaryLicense.test(document.name))) {
      // Some published npm archives declare a license but omit its text. Supplements
      // are reviewed, version-specific source files, never guessed SPDX templates.
      const supplement = resolve('third-party/npm', folder);
      let names: string[] = [];
      try { names = await readdir(supplement); } catch (error) { if (!missing(error)) throw error; }
      for (const name of names.filter(name => noticeDocument.test(name) || name === 'SOURCE.md').sort()) {
        const source = join(supplement, name); if (!(await stat(source)).isFile()) continue;
        documents.push({ name, bytes: new Uint8Array(await readFile(source)) });
      }
    }
    if (!documents.some(document => primaryLicense.test(document.name) && new TextDecoder().decode(document.bytes).trim())) absent.push(key);
    prepared.push({ package: item, folder, documents });
  }
  if (absent.length) throw new Error(`Missing license text for bundled dependencies: ${absent.join(', ')}. Supply their exact upstream license files before packaging.`);

  const index: { name: string; version: string; license: unknown; files: string[] }[] = [];
  await mkdir(directory, { recursive: true });
  for (const item of prepared) {
    const destination = join(directory, item.folder); await mkdir(destination, { recursive: true });
    for (const document of item.documents) await writeFile(join(destination, document.name), document.bytes);
    index.push({ name: item.package.name, version: item.package.version, license: item.package.license,
      files: item.documents.map(document => `${item.folder}/${document.name}`) });
  }
  await writeFile(join(directory, 'index.json'), JSON.stringify({ formatVersion: 1, packages: index }, null, 2) + '\n');
}
