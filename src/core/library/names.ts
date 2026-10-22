import sanitize from 'sanitize-filename';

const encoder = new TextEncoder();
export const portableName = (name: string) => {
  const normalized = name.normalize('NFC'); const dot = normalized.lastIndexOf('.');
  const extension = dot > 0 && /^\.[a-z0-9]{1,16}$/i.test(normalized.slice(dot)) ? normalized.slice(dot) : '';
  let stem = sanitize(extension ? normalized.slice(0, -extension.length) : normalized, { replacement: '_' }) || '_';
  while (encoder.encode(stem + extension).byteLength > 255) stem = Array.from(stem).slice(0, -1).join('');
  return stem + extension;
};
const key = (name: string) => name.normalize('NFC').toLowerCase();

/** Duplicate occurrences keep distinct names regardless of upstream ordering. */
export async function nameEntries<T extends { id: string; name: string; namingIdentity?: string }>(entries: T[]): Promise<(T & { pathName: string })[]> {
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Duplicate directory occurrence identity');
  const names = entries.map(entry => portableName(entry.name));
  const keys = names.map(key);
  const counts = new Map<string, number>();
  for (const folded of keys) counts.set(folded, (counts.get(folded) ?? 0) + 1);
  const lengths: number[] = keys.map(folded => counts.get(folded)! > 1 ? 8 : 0);
  if (!lengths.some(Boolean)) return entries.map((entry, index) => ({ ...entry, pathName: names[index]! }));
  const hashes = new Map<number, string>();
  for (let round = 0; round < 5; round++) {
    const missing: number[] = [];
    lengths.forEach((length, index) => { if (length && !hashes.has(index)) missing.push(index); });
    if (missing.length) await Promise.all(missing.map(async index => {
      const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(entries[index]!.namingIdentity ?? entries[index]!.id));
      hashes.set(index, Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''));
    }));
    const proposed = names.map((name, index) => {
      const length = lengths[index] ?? 0;
      if (!length) return name;
      const suffix = ` [${hashes.get(index)?.slice(0, length)}]`;
      const dot = name.lastIndexOf('.');
      const extension = dot > 0 && name.length - dot < 20 ? name.slice(dot) : '';
      let stem = extension ? name.slice(0, -extension.length) : name;
      while (encoder.encode(stem + suffix + extension).byteLength > 255) stem = Array.from(stem).slice(0, -1).join('');
      return stem + suffix + extension;
    });
    const collisions = new Map<string, number[]>();
    proposed.forEach((name, index) => {
      const folded = lengths[index] ? key(name) : keys[index]!;
      const indexes = collisions.get(folded) ?? []; indexes.push(index); collisions.set(folded, indexes);
    });
    const duplicates = [...collisions.values()].filter(indexes => indexes.length > 1);
    if (!duplicates.length) return entries.map((entry, index) => ({ ...entry, pathName: proposed[index] ?? '_' }));
    for (const indexes of duplicates) for (const index of indexes) lengths[index] = Math.min(64, Math.max(8, (lengths[index] ?? 0) * 2));
  }
  throw new Error('Cannot allocate unambiguous directory names');
}
