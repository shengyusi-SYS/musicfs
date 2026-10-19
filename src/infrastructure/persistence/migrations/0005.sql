ALTER TABLE directory_snapshots ADD COLUMN published_attempt_id TEXT;

CREATE TABLE library_refresh_jobs (
  operation_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  source_epoch INTEGER NOT NULL,
  plugin_revision TEXT NOT NULL,
  plugin_generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'superseded', 'cancelled')),
  revision INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  mutation_token TEXT,
  document TEXT NOT NULL
);
CREATE UNIQUE INDEX library_refresh_active_instance ON library_refresh_jobs(instance_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX library_refresh_ready ON library_refresh_jobs(status, lease_until);
CREATE INDEX library_refresh_instance ON library_refresh_jobs(instance_id);

CREATE TABLE library_snapshot_entries (
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  identity TEXT NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY (attempt_id, ordinal),
  UNIQUE (attempt_id, identity)
);
CREATE INDEX library_snapshot_entries_instance ON library_snapshot_entries(instance_id);
CREATE TABLE library_refresh_cursors (
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  cursor TEXT NOT NULL,
  PRIMARY KEY (attempt_id, cursor)
);
CREATE INDEX library_refresh_cursors_instance ON library_refresh_cursors(instance_id);
