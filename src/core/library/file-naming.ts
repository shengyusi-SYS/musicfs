import type { Entry, FileNamingFacts } from '@musicfs/plugin-api';
import Mustache from 'mustache';
import equal from 'fast-deep-equal';
import { z } from 'zod';
import type { FileNamingPolicy, FileNamingPreview, FileNamingRecord, FileNamingSettings } from '../../contracts/file-naming';
import { nameEntries } from './names';
import { LibraryError } from './types';

type Stored<T> = T | Promise<T>;
export type FileNamingPolicies = { instance: FileNamingRecord; directory: FileNamingRecord | null };
export interface NamingStore {
  fileNamingPolicies(instanceId: string, directoryRef?: string): Stored<FileNamingPolicies>;
  /** Compare the target record's revision. Clearing a policy retains its incremented revision. */
  saveFileNamingPolicy(instanceId: string, directoryRef: string | undefined, expectedRevision: number, policy: FileNamingPolicy | null): Stored<boolean>;
}
const original: FileNamingPolicy = { mode: 'original' };
export const fileNamingFields = (fields: Record<string, string> = {}) => ({ ...fields, originalName: '原文件名（不含扩展名）' });
const padding = z.number().int().min(0).max(12);
const policySchema = z.union([
  z.object({ mode: z.literal('original') }).strict(),
  z.object({ mode: z.literal('template'), template: z.string().trim().min(1).max(4096),
    artistSeparator: z.string().max(32), indexPadding: padding, trackPadding: padding, discPadding: padding }).strict()
]);
const namingFactsSchema = z.object({ identity: z.string().min(1).max(4096),
  fields: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), z.union([z.string(), z.number().finite(), z.array(z.string())])) }).strict();

/** Validate at publication, so a malformed optional plugin field never breaks a later DAV listing. */
export function assertEntryNaming(entry: Extract<Entry, { kind: 'file' }>): void {
  if (entry.naming === undefined) return;
  if (!namingFactsSchema.safeParse(entry.naming).success) throw new LibraryError('invalid_source', '来源返回了无效的文件命名资料。');
}
export function resolveFileNamingPolicy(policies: FileNamingPolicies): FileNamingPolicy {
  return policies.directory?.policy ?? policies.instance.policy ?? original;
}

/** Mustache owns syntax parsing; the supported surface is text, variables and conditional sections. */
function templateFields(writer: Mustache.Writer, template: string): string[] {
  let tokens: ReturnType<Mustache.Writer['parse']>;
  try { tokens = writer.parse(template); }
  catch (error) { throw new LibraryError('invalid_layout', `命名模板语法有误：${error instanceof Error ? error.message : String(error)}`); }
  const fields = new Set<string>();
  const inspect = (items: typeof tokens) => {
    for (const token of items) {
      const [kind, field] = token;
      if (kind === 'text' || kind === '!') continue;
      if (!['name', '&', '#', '^'].includes(kind) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) {
        throw new LibraryError('invalid_layout', '命名模板支持字段和条件块，例如 {{title}}、{{#track}}{{track}} - {{/track}}。');
      }
      fields.add(field);
      if (kind === '#' || kind === '^') inspect(token[4] as typeof tokens);
    }
  };
  inspect(tokens); return [...fields];
}
export function parseFileNamingPolicy(value: unknown, availableFields?: Record<string, string>): FileNamingPolicy | null {
  if (value === null) return null;
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) throw new LibraryError('invalid_layout', '请检查命名模板及格式选项。');
  if (parsed.data.mode === 'template') {
    const fields = templateFields(new Mustache.Writer(), parsed.data.template);
    const unknown = availableFields && fields.filter(field => !Object.hasOwn(availableFields, field));
    if (unknown?.length) throw new LibraryError('invalid_layout', `此来源不支持命名字段：${unknown.join('、')}`);
  }
  return parsed.data;
}

function splitName(name: string) {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && /^\.[a-z0-9]{1,16}$/i.test(name.slice(dot)) ? name.slice(dot) : '';
  return { stem: extension ? name.slice(0, -extension.length) : name, extension };
}
function fieldValues(name: string, facts: FileNamingFacts, policy: Extract<FileNamingPolicy, { mode: 'template' }>) {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(facts.fields)) {
    const width = key === 'index' ? policy.indexPadding : key === 'track' ? policy.trackPadding : key === 'disc' ? policy.discPadding : 0;
    result[key] = Array.isArray(value) ? value.join(policy.artistSeparator)
      : typeof value === 'number' && width ? String(value).padStart(width, '0') : String(value);
  }
  result.originalName = splitName(name).stem;
  return result;
}

type Nameable = { kind: string; name: string; naming?: FileNamingFacts };
/** Names are a projection. No source reference, file attributes or audio bytes are changed. */
export function projectFileNames<T extends Nameable>(entries: T[], policy: FileNamingPolicy): (T & { namingIdentity?: string })[] {
  if (policy.mode === 'original') return entries;
  const writer = new Mustache.Writer(); const requested = templateFields(writer, policy.template);
  const occurrences = new Map<string, number>();
  return entries.map(entry => {
    if (entry.kind !== 'file') return entry;
    const facts = entry.naming;
    // Legacy plugins/snapshots retain their exact names; do not reverse-parse a display string.
    if (!facts) {
      const fields = { originalName: splitName(entry.name).stem };
      if (requested.some(field => field !== 'originalName')) return entry;
      const rendered = writer.render(policy.template, fields, undefined, { escape: value => String(value) }).trim();
      return rendered ? { ...entry, name: rendered + splitName(entry.name).extension } : entry;
    }
    const occurrence = occurrences.get(facts.identity) ?? 0; occurrences.set(facts.identity, occurrence + 1);
    const rendered = writer.render(policy.template, fieldValues(entry.name, facts, policy), undefined, { escape: value => String(value) }).trim();
    return { ...entry, name: rendered ? rendered + splitName(entry.name).extension : entry.name,
      namingIdentity: JSON.stringify([facts.identity, occurrence]) };
  });
}

export async function previewFileNames(entries: Entry[], policy: FileNamingPolicy, limit = 20, currentPolicy: FileNamingPolicy = original): Promise<FileNamingPreview> {
  const before = await nameEntries(projectFileNames(entries, currentPolicy).map(entry => ({ ...entry, id: entry.entryId })));
  const projected = projectFileNames(entries, policy);
  const after = await nameEntries(projected.map(entry => ({ ...entry, id: entry.entryId })));
  const missing = new Set<string>();
  if (policy.mode === 'template') {
    const fields = templateFields(new Mustache.Writer(), policy.template);
    for (const entry of entries) if (entry.kind === 'file') for (const field of fields) {
      const value = field === 'originalName' ? splitName(entry.name).stem : entry.naming?.fields[field];
      if (value === undefined || value === '' || Array.isArray(value) && !value.length) missing.add(field);
    }
  }
  const items = before.flatMap((entry, index) => entry.kind === 'file' ? [{ before: entry.pathName, after: after[index]!.pathName }] : []);
  return { items: items.slice(0, limit), total: items.length, changed: items.filter(item => item.before !== item.after).length, missingFields: [...missing] };
}

export function createFileNaming(store: NamingStore, fields: (instanceId: string) => Promise<Record<string, string>>) {
  const settings = async (instanceId: string, directoryRef?: string): Promise<FileNamingSettings> => {
    const [policies, available] = await Promise.all([store.fileNamingPolicies(instanceId, directoryRef), fields(instanceId)]);
    const record = directoryRef === undefined ? policies.instance : policies.directory ?? { revision: 0, policy: null };
    return { revision: record.revision, policy: record.policy, effectivePolicy: resolveFileNamingPolicy(policies),
      inherited: directoryRef !== undefined && record.policy === null, fields: fileNamingFields(available) };
  };
  return {
    get: settings,
    async set(instanceId: string, directoryRef: string | undefined, expectedRevision: number, value: unknown) {
      const policy = parseFileNamingPolicy(value, fileNamingFields(await fields(instanceId)));
      const policies = await store.fileNamingPolicies(instanceId, directoryRef);
      const record = directoryRef === undefined ? policies.instance : policies.directory ?? { revision: 0, policy: null };
      if (record.revision !== expectedRevision) throw new LibraryError('conflict', '命名设置已变化，请重新打开后再保存。');
      if (equal(record.policy, policy)) return settings(instanceId, directoryRef);
      if (!await store.saveFileNamingPolicy(instanceId, directoryRef, expectedRevision, policy)) throw new LibraryError('conflict', '命名设置已变化，请重新打开后再保存。');
      return settings(instanceId, directoryRef);
    },
    preview: previewFileNames
  };
}
