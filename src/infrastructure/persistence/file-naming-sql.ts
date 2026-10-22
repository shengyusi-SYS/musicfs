import type { FileNamingPolicy } from '../../contracts/file-naming';
import type { FileNamingPolicies } from '../../core/library/file-naming';
import type { SqlStatement } from './refresh-sql';

export type FileNamingRow = { kind: 'instance' | 'directory'; revision: number; policy: string | null };
export const fileNamingPoliciesSQL = `SELECT kind, revision, policy FROM file_naming_policies
  WHERE instance_id = ? AND (kind = 'instance' OR (kind = 'directory' AND ref = ?))`;
/** One existing completed directory; this neither expands the source nor loads its other playlists. */
export const fileNamingPreviewDirectorySQL = `SELECT s.ref FROM directory_snapshots s
  JOIN instances i ON i.id = s.instance_id JOIN installations p ON p.id = i.plugin_id AND p.status = 'active'
  LEFT JOIN file_naming_policies n ON n.instance_id = s.instance_id AND n.kind = 'directory' AND n.ref = s.ref
  WHERE s.instance_id = ? AND s.kind = 'directory' AND s.document IS NOT NULL
    AND n.policy IS NULL
    AND json_extract(s.document, '$.stamp.epoch') = i.epoch
    AND json_extract(s.document, '$.stamp.pluginRevision') = p.revision
    AND json_extract(s.document, '$.stamp.pluginGeneration') = p.generation
    AND (EXISTS (SELECT 1 FROM library_snapshot_entries e WHERE e.attempt_id = s.published_attempt_id AND json_extract(e.document, '$.kind') = 'file')
      OR (s.published_attempt_id IS NULL AND EXISTS (SELECT 1 FROM json_each(s.document, '$.items') e WHERE json_extract(e.value, '$.kind') = 'file')))
  ORDER BY s.rowid LIMIT 1`;
export function fileNamingFromRows(rows: FileNamingRow[], directory: boolean): FileNamingPolicies {
  const record = (kind: FileNamingRow['kind']) => {
    const row = rows.find(value => value.kind === kind);
    return { revision: row?.revision ?? 0, policy: row?.policy == null ? null : JSON.parse(row.policy) as FileNamingPolicy };
  };
  return { instance: record('instance'), directory: directory ? record('directory') : null };
}
export function saveFileNamingStatement(instanceId: string, directoryRef: string | undefined, revision: number, policy: FileNamingPolicy | null): SqlStatement {
  const kind = directoryRef === undefined ? 'instance' : 'directory';
  const ref = directoryRef ?? '';
  const document = policy === null ? null : JSON.stringify(policy);
  return revision === 0
    ? { sql: `INSERT INTO file_naming_policies (instance_id, kind, ref, revision, policy)
        VALUES (?, ?, ?, 1, ?) ON CONFLICT DO NOTHING RETURNING revision`, values: [instanceId, kind, ref, document] }
    : { sql: `UPDATE file_naming_policies SET revision = revision + 1, policy = ?
        WHERE instance_id = ? AND kind = ? AND ref = ? AND revision = ? RETURNING revision`,
      values: [document, instanceId, kind, ref, revision] };
}
