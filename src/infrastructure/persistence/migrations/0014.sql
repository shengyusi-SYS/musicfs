-- Presentation policies are independent of source configuration and immutable file identity.
CREATE TABLE file_naming_policies (
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('instance', 'directory')),
  ref TEXT NOT NULL,
  revision INTEGER NOT NULL,
  policy TEXT,
  PRIMARY KEY (instance_id, kind, ref)
);
