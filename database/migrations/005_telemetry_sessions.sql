CREATE TABLE IF NOT EXISTS telemetry_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL,
  last_position_at TIMESTAMPTZ NOT NULL,
  last_latitude DOUBLE PRECISION NOT NULL,
  last_longitude DOUBLE PRECISION NOT NULL,
  distance_m DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (distance_m >= 0),
  max_speed DOUBLE PRECISION,
  speed_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
  speed_samples INTEGER NOT NULL DEFAULT 0 CHECK (speed_samples >= 0),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS telemetry_sessions_device_active_idx
  ON telemetry_sessions(device_id, started_at DESC)
  WHERE ended_at IS NULL;
