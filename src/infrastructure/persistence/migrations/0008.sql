CREATE TABLE source_plugin_cache (
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  plugin_revision TEXT NOT NULL,
  plugin_generation INTEGER NOT NULL,
  document TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (instance_id, cache_key)
);
