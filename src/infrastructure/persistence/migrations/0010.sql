CREATE TABLE refresh_schedules (
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('roots', 'directory')),
  ref TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes >= 15),
  next_run_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, kind, ref),
  CHECK (kind != 'roots' OR ref = '')
);
CREATE INDEX refresh_schedules_due ON refresh_schedules(next_run_at);
