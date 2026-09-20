ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS public_share_id UUID UNIQUE,
  ADD COLUMN IF NOT EXISTS public_share_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS public_share_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS devices_public_share_lookup_idx
  ON devices(public_share_id)
  WHERE public_share_enabled = TRUE;
