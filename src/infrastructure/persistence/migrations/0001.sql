CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  manifest TEXT NOT NULL,
  revision TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'missing'))
);
CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES installations(id),
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  private_state TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  state_revision INTEGER NOT NULL
);
CREATE INDEX instances_plugin ON instances(plugin_id);
