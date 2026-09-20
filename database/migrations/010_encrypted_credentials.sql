ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS device_key_encrypted TEXT;

ALTER TABLE overlays
  ADD COLUMN IF NOT EXISTS access_key_encrypted TEXT;
