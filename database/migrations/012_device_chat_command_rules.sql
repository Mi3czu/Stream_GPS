-- Chat command rules are scoped to a GPS device. They are inert until a chat
-- platform integration is explicitly connected by the account owner.
CREATE TABLE IF NOT EXISTS device_chat_command_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('map', 'gps_status', 'private_mode', 'live_mode', 'hide_overlay', 'show_overlay', 'panic')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  command TEXT NOT NULL,
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  minimum_role TEXT NOT NULL CHECK (minimum_role IN ('viewer', 'moderator', 'admin', 'owner')),
  cooldown_seconds INTEGER NOT NULL DEFAULT 10 CHECK (cooldown_seconds BETWEEN 0 AND 3600),
  response_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(device_id, action)
);

CREATE INDEX IF NOT EXISTS device_chat_command_rules_device_idx
  ON device_chat_command_rules(device_id);
