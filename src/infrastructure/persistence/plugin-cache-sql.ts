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

export function cachePluginDataPlan(source: SourceStamp, key: string, document: string, expiresAt: number | null, now: number): SqlStatement[] {
  return [{
    // Opportunistic cleanup needs no recurring job and cannot delete the replacement source's data.
    sql: `DELETE FROM source_plugin_cache WHERE instance_id = ? AND
      ((expires_at IS NOT NULL AND expires_at <= ?) OR epoch != ? OR plugin_revision != ? OR plugin_generation != ?)
      AND EXISTS (${current})`,
    values: [source.id, now, source.epoch, source.pluginRevision, source.pluginGeneration, ...sourceValues(source)]
  }, {
    sql: `INSERT INTO source_plugin_cache (instance_id, cache_key, epoch, plugin_revision, plugin_generation, document, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${current})
      ON CONFLICT(instance_id, cache_key) DO UPDATE SET epoch = excluded.epoch, plugin_revision = excluded.plugin_revision,
      plugin_generation = excluded.plugin_generation, document = excluded.document, expires_at = excluded.expires_at RETURNING 1 AS written`,
    values: [source.id, key, source.epoch, source.pluginRevision, source.pluginGeneration, document, expiresAt, ...sourceValues(source)]
  }];
}
