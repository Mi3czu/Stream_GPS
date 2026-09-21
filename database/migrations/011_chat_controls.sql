-- Optional chat integrations. No existing device, public map or overlay is enabled
-- by this migration; chat control only becomes active after an owner connects it.
ALTER TABLE overlays
  ADD COLUMN IF NOT EXISTS visible BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS chat_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('kick', 'twitch')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  channel_id TEXT,
  channel_name TEXT,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,
  settings JSONB NOT NULL DEFAULT '{"viewer_commands":true,"moderator_emergency_off":true,"command_prefix":"!"}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner_id, platform)
);

CREATE TABLE IF NOT EXISTS chat_authorized_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL REFERENCES chat_integrations(id) ON DELETE CASCADE,
  platform_user_id TEXT NOT NULL,
  username TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'moderator')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(integration_id, platform_user_id)
);

CREATE TABLE IF NOT EXISTS chat_command_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  integration_id UUID REFERENCES chat_integrations(id) ON DELETE SET NULL,
  platform_event_id TEXT,
  platform_user_id TEXT,
  command TEXT NOT NULL,
  outcome TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(integration_id, platform_event_id)
);

CREATE INDEX IF NOT EXISTS chat_integrations_owner_idx ON chat_integrations(owner_id);
CREATE INDEX IF NOT EXISTS chat_command_events_created_idx ON chat_command_events(created_at DESC);
