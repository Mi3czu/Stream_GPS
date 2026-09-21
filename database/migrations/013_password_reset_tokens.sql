CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  requested_ip TEXT
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_active_idx
  ON password_reset_tokens(token_hash, expires_at)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS password_reset_tokens_admin_idx
  ON password_reset_tokens(admin_id, requested_at DESC);
