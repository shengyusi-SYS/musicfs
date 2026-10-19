CREATE TABLE worker_plugin_changes (
  operation_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  document TEXT NOT NULL,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX worker_single_plugin_change ON worker_plugin_changes ((1))
  WHERE status NOT IN ('completed', 'failed');
CREATE TABLE worker_plugin_change_files (
  operation_id TEXT NOT NULL REFERENCES worker_plugin_changes(operation_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (operation_id, name, chunk_index)
);
