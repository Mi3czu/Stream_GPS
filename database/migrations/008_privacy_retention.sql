ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS retention_days INTEGER
    CHECK (retention_days IS NULL OR retention_days IN (7, 30, 90, 365));

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS retention_last_run_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS devices_owner_id_id_idx ON devices(owner_id, id);
