CREATE TABLE source_renewals (
  instance_id TEXT PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  plugin_revision TEXT NOT NULL,
  plugin_generation INTEGER NOT NULL,
  state_revision INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  fault TEXT,
  retry_at INTEGER NOT NULL DEFAULT 0,
  mutation_token TEXT
);
