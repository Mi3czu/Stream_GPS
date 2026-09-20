BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  device_key_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  last_latitude DOUBLE PRECISION CHECK (last_latitude IS NULL OR last_latitude BETWEEN -90 AND 90),
  last_longitude DOUBLE PRECISION CHECK (last_longitude IS NULL OR last_longitude BETWEEN -180 AND 180),
  last_altitude DOUBLE PRECISION,
  last_speed DOUBLE PRECISION CHECK (last_speed IS NULL OR last_speed >= 0),
  last_heading DOUBLE PRECISION CHECK (last_heading IS NULL OR last_heading >= 0 AND last_heading < 360),
  last_accuracy DOUBLE PRECISION CHECK (last_accuracy IS NULL OR last_accuracy >= 0),
  last_satellites INTEGER CHECK (last_satellites IS NULL OR last_satellites >= 0),
  last_recorded_at TIMESTAMPTZ
);

CREATE TABLE gps_positions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  altitude DOUBLE PRECISION,
  speed DOUBLE PRECISION CHECK (speed IS NULL OR speed >= 0),
  heading DOUBLE PRECISION CHECK (heading IS NULL OR heading >= 0 AND heading < 360),
  accuracy DOUBLE PRECISION CHECK (accuracy IS NULL OR accuracy >= 0),
  satellites INTEGER CHECK (satellites IS NULL OR satellites >= 0),
  recorded_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX gps_positions_device_recorded_at_idx
  ON gps_positions (device_id, recorded_at DESC);

CREATE TABLE request_nonces (
  nonce UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX request_nonces_expires_at_idx ON request_nonces (expires_at);

COMMIT;
