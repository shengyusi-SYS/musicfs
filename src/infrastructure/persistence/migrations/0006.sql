ALTER TABLE worker_plugin_changes RENAME TO plugin_changes;
ALTER TABLE plugin_changes ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plugin_changes ADD COLUMN mutation_token TEXT;

-- No FK to instances: a removed instance must remain in the frozen input set.
CREATE TABLE plugin_change_instances (
  operation_id TEXT NOT NULL REFERENCES plugin_changes(operation_id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  private_state TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  state_revision INTEGER NOT NULL,
  candidate_config TEXT,
  candidate_state TEXT,
  PRIMARY KEY (operation_id, instance_id),
  CHECK ((candidate_config IS NULL) = (candidate_state IS NULL))
);
