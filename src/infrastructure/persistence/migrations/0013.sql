CREATE TABLE automatic_update_rules (
  id TEXT PRIMARY KEY NOT NULL,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  timing TEXT NOT NULL,
  label TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  operation_id TEXT,
  last_run_at INTEGER,
  settled INTEGER NOT NULL DEFAULT 1 CHECK (settled IN (0, 1))
);
CREATE UNIQUE INDEX automatic_update_rule_target ON automatic_update_rules(instance_id, target);
CREATE INDEX automatic_update_rules_due ON automatic_update_rules(enabled, next_run_at);
INSERT INTO automatic_update_rules (id, instance_id, target, timing, enabled, next_run_at)
  SELECT lower(hex(randomblob(16))), instance_id,
    CASE WHEN kind = 'roots' THEN json_object('kind', 'roots')
      ELSE json_object('kind', 'directory', 'directoryRef', ref, 'recursive', json('false')) END,
    json_object('kind', 'interval', 'minutes', interval_minutes), 1, next_run_at
  FROM refresh_schedules;
DROP TABLE refresh_schedules;
