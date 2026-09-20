BEGIN;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES admins(id) ON DELETE CASCADE;

-- Preserve installations created before multi-user support: the oldest account
-- becomes the owner of all devices that did not have an owner yet.
UPDATE devices
SET owner_id = (SELECT id FROM admins ORDER BY created_at ASC LIMIT 1)
WHERE owner_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM devices WHERE owner_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot migrate devices without an existing account owner';
  END IF;
END $$;

ALTER TABLE devices ALTER COLUMN owner_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS devices_owner_created_at_idx
  ON devices(owner_id, created_at DESC);

COMMIT;
