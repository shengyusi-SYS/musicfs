CREATE TABLE directory_snapshots (
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('roots', 'directory')),
  ref TEXT NOT NULL,
  request_id TEXT NOT NULL,
  document TEXT,
  error TEXT,
  PRIMARY KEY (instance_id, kind, ref)
);
CREATE TABLE library_layout (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  nodes TEXT
);
INSERT INTO library_layout (id, revision, nodes) VALUES (1, 0, NULL);
