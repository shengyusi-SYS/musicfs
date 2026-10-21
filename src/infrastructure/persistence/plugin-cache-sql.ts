import type { SourceStamp } from '../../core/sources/types';
import type { SqlStatement } from './refresh-sql';

const current = `SELECT 1 FROM instances i JOIN installations p ON p.id = i.plugin_id
  WHERE i.id = ? AND i.epoch = ? AND p.revision = ? AND p.generation = ? AND p.status = 'active'`;
const sourceValues = (source: SourceStamp) => [source.id, source.epoch, source.pluginRevision, source.pluginGeneration];

export function cachedPluginDataStatement(source: SourceStamp, key: string, now: number): SqlStatement {
  return {
    sql: `SELECT document FROM source_plugin_cache WHERE instance_id = ? AND cache_key = ?
      AND epoch = ? AND plugin_revision = ? AND plugin_generation = ? AND (expires_at IS NULL OR expires_at > ?)
      AND EXISTS (${current})`,
    values: [source.id, key, source.epoch, source.pluginRevision, source.pluginGeneration, now, ...sourceValues(source)]
  };
}

export function cachedPluginDataManyStatement(source: SourceStamp, keys: string[], now: number): SqlStatement {
  return {
    sql: `SELECT cache_key AS key, document FROM source_plugin_cache WHERE instance_id = ?
      AND cache_key IN (SELECT value FROM json_each(?)) AND epoch = ? AND plugin_revision = ? AND plugin_generation = ?
      AND (expires_at IS NULL OR expires_at > ?) AND EXISTS (${current})`,
    values: [source.id, JSON.stringify(keys), source.epoch, source.pluginRevision, source.pluginGeneration, now, ...sourceValues(source)]
  };
}

export function cachePluginDataPlan(source: SourceStamp, key: string, document: string, expiresAt: number | null, now: number): SqlStatement[] {
  return [cleanupPluginData(source, now), {
    sql: `INSERT INTO source_plugin_cache (instance_id, cache_key, epoch, plugin_revision, plugin_generation, document, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${current})
      ON CONFLICT(instance_id, cache_key) DO UPDATE SET epoch = excluded.epoch, plugin_revision = excluded.plugin_revision,
      plugin_generation = excluded.plugin_generation, document = excluded.document, expires_at = excluded.expires_at RETURNING 1 AS written`,
    values: [source.id, key, source.epoch, source.pluginRevision, source.pluginGeneration, document, expiresAt, ...sourceValues(source)]
  }];
}

function cleanupPluginData(source: SourceStamp, now: number): SqlStatement {
  // Disjoint indexed ranges avoid scanning every live plan on each cleanup.
  const ranges: { condition: string; values: (string | number)[] }[] = [
    { condition: 'expires_at <= ?', values: [now] },
    ...['<', '>'].map(compare => ({ condition: `(epoch, plugin_generation, plugin_revision) ${compare} (?, ?, ?)`,
      values: [source.epoch, source.pluginGeneration, source.pluginRevision] }))
  ];
  return { sql: `DELETE FROM source_plugin_cache WHERE rowid IN (${ranges.map(range =>
    `SELECT rowid FROM source_plugin_cache WHERE instance_id = ? AND ${range.condition}`).join(' UNION ALL ')}) AND EXISTS (${current})`,
    values: [...ranges.flatMap(range => [source.id, ...range.values]), ...sourceValues(source)] };
}

export function cachePluginDataManyPlan(source: SourceStamp, items: { key: string; document: string; expiresAt: number | null }[], now: number): SqlStatement[] {
  return [cleanupPluginData(source, now), {
    sql: `INSERT INTO source_plugin_cache (instance_id, cache_key, epoch, plugin_revision, plugin_generation, document, expires_at)
      SELECT ?, json_extract(p.value, '$.key'), ?, ?, ?, json_extract(p.value, '$.document'), json_extract(p.value, '$.expiresAt')
      FROM json_each(?) p WHERE EXISTS (${current})
      ON CONFLICT(instance_id, cache_key) DO UPDATE SET epoch = excluded.epoch, plugin_revision = excluded.plugin_revision,
      plugin_generation = excluded.plugin_generation, document = excluded.document, expires_at = excluded.expires_at RETURNING 1 AS written`,
    values: [source.id, source.epoch, source.pluginRevision, source.pluginGeneration, JSON.stringify(items), ...sourceValues(source)]
  }];
}

/** Preserve a live winner; stale/expired rows can be replaced even when cleanup is skipped. */
export function cachePluginDataIfAbsentPlan(source: SourceStamp, key: string, document: string, now: number): SqlStatement[] {
  return [cleanupPluginData(source, now), {
    sql: `INSERT INTO source_plugin_cache (instance_id, cache_key, epoch, plugin_revision, plugin_generation, document, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, NULL WHERE EXISTS (${current})
      ON CONFLICT(instance_id, cache_key) DO UPDATE SET epoch = excluded.epoch, plugin_revision = excluded.plugin_revision,
      plugin_generation = excluded.plugin_generation, document = excluded.document, expires_at = NULL
      WHERE epoch != excluded.epoch OR plugin_revision != excluded.plugin_revision OR plugin_generation != excluded.plugin_generation
        OR expires_at <= ?`,
    values: [source.id, key, source.epoch, source.pluginRevision, source.pluginGeneration, document, ...sourceValues(source), now]
  }, cachedPluginDataStatement(source, key, now)];
}
