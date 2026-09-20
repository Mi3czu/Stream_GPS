const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('./database/postgres');
const { authenticate } = require('./auth');
const { authenticateDevice, sendError } = require('./device-auth');

const app = express();
const port = Number(process.env.PORT || 3000);
const overlayStreams = new Map();
const deviceStreams = new Map();
const ADMIN_SESSION_HOURS = 8;
const LOGIN_WINDOW_MINUTES = 15;
const MAX_LOGIN_FAILURES = 5;

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is required');
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

app.get('/api/openapi.yaml', (req, res) => {
  res.type('text/yaml').send(fs.readFileSync(path.join(__dirname, 'openapi.yaml'), 'utf8'));
});

app.get('/api/docs', (req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Stream GPS API</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:'/api/openapi.yaml',dom_id:'#swagger-ui',deepLinking:true,persistAuthorization:false});</script></body></html>`);
});

function loginIdentifier(req, username) {
  return crypto.createHash('sha256')
    .update(`${req.ip}|${String(username || '').trim().toLowerCase()}`)
    .digest('hex');
}

async function recordAudit(req, action, targetType = null, targetId = null, metadata = {}) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (admin_id, action, target_type, target_id, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [req.user?.sub || null, action, targetType, targetId, JSON.stringify(metadata), req.ip]
    );
  } catch (error) {
    console.error('Audit log error:', error.message);
  }
}

const DEFAULT_OVERLAY_CONFIG = {
  mapTheme: 'standard',
  textTheme: 'glass',
  textColor: '#ffffff',
  fontFamily: 'monospace',
  mapShape: 'round',
  mapSize: 360,
  borderColor: '#ffffff',
  autoZoom: true,
  minSpeed: 0,
  maxSpeed: 120,
  maxZoom: 16,
  minZoom: 10,
  stats: {
    speed: true,
    direction: true,
    altitude: false,
    accuracy: false,
    gpsSignal: false,
    localTime: true,
    maxSpeed: false,
    avgSpeed: false,
    tripDistance: false
  },
  statsPosition: 'below-map',
  statsTextSize: 14
};

function normalizeOverlayConfig(input) {
  return {
    ...DEFAULT_OVERLAY_CONFIG,
    ...(input || {}),
    stats: { ...DEFAULT_OVERLAY_CONFIG.stats, ...((input || {}).stats || {}) }
  };
}

function validateOverlayConfig(input) {
  const config = normalizeOverlayConfig(input);
  if (config.mapTheme === 'dark') config.mapTheme = 'night';
  const mapThemes = new Set(['standard', 'night', 'satellite']);
  const textThemes = new Set(['glass', 'light', 'dark']);
  const fonts = new Set(['monospace', 'Arial, sans-serif', 'Roboto, sans-serif', 'Inter, sans-serif', 'Oswald, sans-serif']);
  const color = /^#[0-9a-fA-F]{6}$/;

  const minSpeed = Number(config.minSpeed);
  const maxSpeed = Number(config.maxSpeed);
  const maxZoom = Number(config.maxZoom);
  const minZoom = Number(config.minZoom);
  if (!mapThemes.has(config.mapTheme) || !textThemes.has(config.textTheme) ||
      !fonts.has(config.fontFamily) || !['round', 'square'].includes(config.mapShape) ||
      !color.test(config.textColor) || !color.test(config.borderColor) ||
      !Number.isInteger(Number(config.mapSize)) || Number(config.mapSize) < 200 || Number(config.mapSize) > 600) {
    return null;
  }
  if (typeof config.autoZoom !== 'boolean' || !Number.isInteger(minSpeed) || !Number.isInteger(maxSpeed) ||
      !Number.isInteger(maxZoom) || !Number.isInteger(minZoom) || minSpeed < 0 || maxSpeed > 300 ||
      minSpeed >= maxSpeed || minZoom < 3 || maxZoom > 19 || minZoom >= maxZoom) return null;
  const statNames = Object.keys(DEFAULT_OVERLAY_CONFIG.stats);
  if (!statNames.every((name) => typeof config.stats[name] === 'boolean') ||
      !['above-map', 'below-map'].includes(config.statsPosition) ||
      !Number.isInteger(Number(config.statsTextSize)) || Number(config.statsTextSize) < 10 || Number(config.statsTextSize) > 28) return null;
  return { ...config, mapSize: Number(config.mapSize), minSpeed, maxSpeed, minZoom, maxZoom, statsTextSize: Number(config.statsTextSize) };
}

function writeSse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function publishOverlayEvent(overlayId, event, data) {
  const listeners = overlayStreams.get(overlayId);
  if (!listeners) return;
  for (const response of listeners) writeSse(response, event, data);
}

function publishDeviceEvent(deviceId, event, data) {
  const listeners = deviceStreams.get(deviceId);
  if (!listeners) return;
  for (const response of listeners) writeSse(response, event, data);
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function getOverlayForPublicAccess(overlayId, accessKey) {
  const result = await pool.query(
    `SELECT o.id, o.access_key_hash, o.config, d.name, d.device_id, d.status, d.last_seen_at,
            d.last_latitude, d.last_longitude, d.last_speed, d.last_heading, d.last_altitude,
            d.last_accuracy, d.last_satellites, d.last_recorded_at,
            session.distance_m AS trip_distance_m, session.max_speed AS max_session_speed,
            CASE WHEN session.speed_samples > 0 THEN session.speed_sum / session.speed_samples END AS avg_session_speed
     FROM overlays o JOIN devices d ON d.id = o.device_id
     LEFT JOIN LATERAL (
       SELECT distance_m, max_speed, speed_sum, speed_samples FROM telemetry_sessions
       WHERE device_id = d.id AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1
     ) session ON TRUE
     WHERE o.id = $1 AND o.status = 'active'`,
    [overlayId]
  );
  const overlay = result.rows[0];
  if (!overlay || !(await bcrypt.compare(accessKey, overlay.access_key_hash))) return null;
  return overlay;
}

function overlayDeviceData(overlay) {
  return {
    name: overlay.name, device_id: overlay.device_id, status: overlay.status,
    last_seen_at: overlay.last_seen_at, latitude: overlay.last_latitude,
    longitude: overlay.last_longitude, speed: overlay.last_speed,
    heading: overlay.last_heading, altitude: overlay.last_altitude,
    accuracy: overlay.last_accuracy, satellites: overlay.last_satellites,
    recorded_at: overlay.last_recorded_at, trip_distance_m: overlay.trip_distance_m,
    max_session_speed: overlay.max_session_speed, avg_session_speed: overlay.avg_session_speed
  };
}

function haversineMeters(latitudeA, longitudeA, latitudeB, longitudeB) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const earthRadius = 6_371_000;
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const a = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(latitudeA)) *
    Math.cos(radians(latitudeB)) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function updateTelemetrySession(client, device, position) {
  await client.query('SELECT id FROM devices WHERE id = $1 FOR UPDATE', [device.id]);
  const result = await client.query(
    `SELECT * FROM telemetry_sessions
     WHERE device_id = $1 AND ended_at IS NULL
     ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
    [device.id]
  );
  let session = result.rows[0];
  const positionTime = position.recordedAt.getTime();

  if (session && positionTime - new Date(session.last_position_at).getTime() > 15 * 60 * 1000) {
    await client.query('UPDATE telemetry_sessions SET ended_at = last_position_at, updated_at = NOW() WHERE id = $1', [session.id]);
    session = null;
  }

  if (!session) {
    const speedSamples = position.speed === undefined ? 0 : 1;
    const created = await client.query(
      `INSERT INTO telemetry_sessions
       (device_id, started_at, last_position_at, last_latitude, last_longitude, max_speed, speed_sum, speed_samples)
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7)
       RETURNING distance_m, max_speed, speed_sum, speed_samples`,
      [device.id, position.recordedAt, position.latitude, position.longitude,
        position.speed ?? null, position.speed ?? 0, speedSamples]
    );
    session = created.rows[0];
  } else {
    const segmentDistance = haversineMeters(session.last_latitude, session.last_longitude, position.latitude, position.longitude);
    const nextDistance = session.distance_m + segmentDistance;
    const nextSamples = session.speed_samples + (position.speed === undefined ? 0 : 1);
    const nextSpeedSum = session.speed_sum + (position.speed ?? 0);
    const nextMaxSpeed = position.speed === undefined ? session.max_speed : Math.max(session.max_speed ?? 0, position.speed);
    const updated = await client.query(
      `UPDATE telemetry_sessions SET last_position_at = $2, last_latitude = $3, last_longitude = $4,
       distance_m = $5, max_speed = $6, speed_sum = $7, speed_samples = $8, updated_at = NOW()
       WHERE id = $1 RETURNING distance_m, max_speed, speed_sum, speed_samples`,
      [session.id, position.recordedAt, position.latitude, position.longitude, nextDistance,
        nextMaxSpeed, nextSpeedSum, nextSamples]
    );
    session = updated.rows[0];
  }

  return {
    trip_distance_m: session.distance_m,
    max_session_speed: session.max_speed,
    avg_session_speed: session.speed_samples ? session.speed_sum / session.speed_samples : null
  };
}

async function publishDevicePosition(device, position, sessionMetrics) {
  const result = await pool.query(
    'SELECT id FROM overlays WHERE device_id = $1 AND status = $2',
    [device.id, 'active']
  );
  const payload = {
    name: device.name, device_id: device.device_id, status: 'active',
    last_seen_at: new Date().toISOString(), latitude: position.latitude,
    longitude: position.longitude, speed: position.speed ?? null,
    heading: position.heading ?? null, altitude: position.altitude ?? null,
    accuracy: position.accuracy ?? null, satellites: position.satellites ?? null,
    recorded_at: position.recordedAt.toISOString(), ...sessionMetrics
  };
  publishDeviceEvent(device.id, 'position', { device: payload });
  for (const overlay of result.rows) publishOverlayEvent(overlay.id, 'position', { device: payload });
}

async function runRetentionCleanup(ownerId) {
  const claim = await pool.query(
    `UPDATE admins SET retention_last_run_at = NOW()
     WHERE id = $1 AND retention_days IS NOT NULL
       AND (retention_last_run_at IS NULL OR retention_last_run_at < NOW() - INTERVAL '1 day')
     RETURNING retention_days`,
    [ownerId]
  );
  if (!claim.rows[0]) return;
  await pool.query(
    `DELETE FROM gps_positions p USING devices d
     WHERE p.device_id = d.id AND d.owner_id = $1
       AND p.recorded_at < NOW() - ($2 * INTERVAL '1 day')`,
    [ownerId, claim.rows[0].retention_days]
  );
}

function validateGpsPosition(body) {
  const latitude = Number(body.latitude);
  const longitude = Number(body.longitude);
  const optionalNumbers = ['altitude', 'speed', 'heading', 'accuracy'];
  const position = { latitude, longitude };

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { error: 'INVALID_LATITUDE', message: 'latitude must be between -90 and 90' };
  }

  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { error: 'INVALID_LONGITUDE', message: 'longitude must be between -180 and 180' };
  }

  for (const field of optionalNumbers) {
    if (body[field] !== undefined && body[field] !== null) {
      const value = Number(body[field]);
      if (!Number.isFinite(value)) {
        return { error: 'INVALID_GPS_VALUE', message: `${field} must be a number` };
      }
      position[field] = value;
    }
  }

  if (position.speed !== undefined && position.speed < 0) {
    return { error: 'INVALID_SPEED', message: 'speed cannot be negative' };
  }
  if (position.heading !== undefined && (position.heading < 0 || position.heading >= 360)) {
    return { error: 'INVALID_HEADING', message: 'heading must be between 0 and 360' };
  }
  if (position.accuracy !== undefined && position.accuracy < 0) {
    return { error: 'INVALID_ACCURACY', message: 'accuracy cannot be negative' };
  }

  if (body.satellites !== undefined && body.satellites !== null) {
    position.satellites = Number(body.satellites);
    if (!Number.isInteger(position.satellites) || position.satellites < 0) {
      return { error: 'INVALID_SATELLITES', message: 'satellites must be a non-negative integer' };
    }
  }

  position.recordedAt = body.recorded_at ? new Date(body.recorded_at) : new Date();
  if (Number.isNaN(position.recordedAt.getTime())) {
    return { error: 'INVALID_TIMESTAMP', message: 'recorded_at must be a valid ISO-8601 timestamp' };
  }

  return { position };
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'ok' });
  } catch (error) {
    console.error('Health check failed:', error.message);
    res.status(503).json({ status: 'unavailable', database: 'unavailable' });
  }
});

app.get('/ready', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '008_privacy_retention.sql') AS migrations_ready`
    );
    if (!result.rows[0].migrations_ready) return res.status(503).json({ status: 'not_ready', database: 'ok', migrations: 'pending' });
    res.json({ status: 'ready', database: 'ok', migrations: 'ok' });
  } catch (error) {
    console.error('Readiness check failed:', error.message);
    res.status(503).json({ status: 'not_ready', database: 'unavailable', migrations: 'unknown' });
  }
});

app.get('/api/setup/status', async (req, res) => {
  try {
    res.json({ registration_allowed: true, account_mode: 'multi-user' });
  } catch (error) {
    console.error('Setup status error:', error.message);
    res.status(500).json({ message: 'Unable to check setup status' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!username || !email || !password) return res.status(400).json({ message: 'Username, email, and password are required' });
    if (!/^[a-zA-Z0-9_-]{3,50}$/.test(username)) return res.status(400).json({ message: 'Username must be 3-50 characters and contain only letters, digits, underscores, or hyphens' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email address' });
    if (password.length < 12) return res.status(400).json({ message: 'Password must contain at least 12 characters' });

    const result = await pool.query(
      `INSERT INTO admins (username, email, password_hash)
       VALUES ($1, $2, $3) RETURNING id, username, email`,
      [username, email, await bcrypt.hash(password, 12)]
    );
    req.user = { sub: result.rows[0].id };
    await recordAudit(req, 'account.created', 'account', result.rows[0].id);
    res.status(201).json({ message: 'Account created successfully. You can now log in.', user: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'Username or email already exists' });
    console.error('Registration error:', error.message);
    res.status(500).json({ message: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    const identifier = loginIdentifier(req, username);
    await pool.query(`DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL '1 day'`);
    const attempts = await pool.query(
      `SELECT COUNT(*)::int AS failures FROM login_attempts
       WHERE identifier_hash = $1 AND attempted_at > NOW() - ($2 * INTERVAL '1 minute')`,
      [identifier, LOGIN_WINDOW_MINUTES]
    );
    if (attempts.rows[0].failures >= MAX_LOGIN_FAILURES) {
      res.set('Retry-After', String(LOGIN_WINDOW_MINUTES * 60));
      return res.status(429).json({ message: 'Too many failed login attempts. Try again later.' });
    }

    const result = await pool.query(
      `SELECT id, username, password_hash
       FROM admins
       WHERE username = $1`,
      [username]
    );
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      await pool.query('INSERT INTO login_attempts (identifier_hash) VALUES ($1)', [identifier]);
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    await pool.query('DELETE FROM login_attempts WHERE identifier_hash = $1', [identifier]);
    const sessionId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO admin_sessions (id, admin_id, expires_at, ip_address, user_agent)
       VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 hour'), $4, $5)`,
      [sessionId, user.id, ADMIN_SESSION_HOURS, req.ip, req.get('User-Agent')?.slice(0, 500) || null]
    );

    const token = jwt.sign(
      { username: user.username, sessionId },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', subject: user.id, expiresIn: `${ADMIN_SESSION_HOURS}h` }
    );

    req.user = { sub: user.id };
    await recordAudit(req, 'account.login', 'session', sessionId);

    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, username: user.username }
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ message: 'Login failed' });
  }
});

app.post('/api/logout', authenticate, async (req, res) => {
  try {
    await pool.query('UPDATE admin_sessions SET revoked_at = NOW() WHERE id = $1', [req.sessionId]);
    await recordAudit(req, 'account.logout', 'session', req.sessionId);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error.message);
    res.status(500).json({ message: 'Logout failed' });
  }
});

app.get('/api/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, retention_days FROM admins WHERE id = $1',
      [req.user.sub]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ message: 'User account no longer exists' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Current-user error:', error.message);
    res.status(500).json({ message: 'Unable to load current user' });
  }
});

app.patch('/api/me/privacy', authenticate, async (req, res) => {
  try {
    const rawDays = req.body.retention_days;
    const retentionDays = rawDays === null || rawDays === 'forever' ? null : Number(rawDays);
    if (retentionDays !== null && ![7, 30, 90, 365].includes(retentionDays)) {
      return sendError(res, 400, 'RETENTION_INVALID', 'Retention must be 7, 30, 90, 365 days, or forever');
    }
    await pool.query(
      `UPDATE admins SET retention_days = $1, retention_last_run_at = NULL, updated_at = NOW() WHERE id = $2`,
      [retentionDays, req.user.sub]
    );
    if (retentionDays !== null) await runRetentionCleanup(req.user.sub);
    await recordAudit(req, 'account.retention_updated', 'account', req.user.sub, { retention_days: retentionDays });
    res.json({ message: 'GPS history retention updated', retention_days: retentionDays });
  } catch (error) {
    console.error('Retention update error:', error.message);
    sendError(res, 500, 'RETENTION_UPDATE_FAILED', 'Unable to update retention');
  }
});

app.patch('/api/me/password', authenticate, async (req, res) => {
  try {
    const currentPassword = String(req.body.current_password || '');
    const newPassword = String(req.body.new_password || '');
    if (!currentPassword || !newPassword) {
      return sendError(res, 400, 'PASSWORD_FIELDS_REQUIRED', 'Current and new password are required');
    }
    if (newPassword.length < 12) {
      return sendError(res, 400, 'PASSWORD_TOO_SHORT', 'New password must contain at least 12 characters');
    }
    if (currentPassword === newPassword) {
      return sendError(res, 400, 'PASSWORD_UNCHANGED', 'New password must be different from the current password');
    }

    const accountResult = await pool.query('SELECT password_hash FROM admins WHERE id = $1', [req.user.sub]);
    const account = accountResult.rows[0];
    if (!account || !(await bcrypt.compare(currentPassword, account.password_hash))) {
      return sendError(res, 401, 'CURRENT_PASSWORD_INVALID', 'Current password is incorrect');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE admins SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [await bcrypt.hash(newPassword, 12), req.user.sub]
      );
      await client.query(
        `UPDATE admin_sessions SET revoked_at = NOW()
         WHERE admin_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [req.user.sub, req.sessionId]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await recordAudit(req, 'account.password_changed', 'account', req.user.sub);
    res.json({ message: 'Password changed. Other sessions have been signed out.' });
  } catch (error) {
    console.error('Password change error:', error.message);
    sendError(res, 500, 'PASSWORD_CHANGE_FAILED', 'Unable to change password');
  }
});

app.get('/api/v1/account/sessions', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, created_at, expires_at, ip_address, user_agent, id = $2 AS current
       FROM admin_sessions
       WHERE admin_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [req.user.sub, req.sessionId]
    );
    res.json({ sessions: result.rows });
  } catch (error) {
    console.error('Session list error:', error.message);
    sendError(res, 500, 'SESSION_LIST_FAILED', 'Unable to load active sessions');
  }
});

app.post('/api/v1/account/sessions/revoke-others', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE admin_sessions SET revoked_at = NOW()
       WHERE admin_id = $1 AND id <> $2 AND revoked_at IS NULL
       RETURNING id`,
      [req.user.sub, req.sessionId]
    );
    await recordAudit(req, 'account.other_sessions_revoked', 'account', req.user.sub, {
      revoked_sessions: result.rowCount
    });
    res.json({ message: 'Other sessions signed out', revoked_sessions: result.rowCount });
  } catch (error) {
    console.error('Session revoke error:', error.message);
    sendError(res, 500, 'SESSION_REVOKE_FAILED', 'Unable to sign out other sessions');
  }
});

app.get('/api/v1/audit-logs', authenticate, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const result = await pool.query(
      `SELECT l.id, l.action, l.target_type, l.target_id, l.metadata,
              l.ip_address, l.created_at, a.username
       FROM audit_logs l LEFT JOIN admins a ON a.id = l.admin_id
       WHERE l.admin_id = $1
       ORDER BY l.created_at DESC LIMIT $2`,
      [req.user.sub, limit]
    );
    res.json({ logs: result.rows });
  } catch (error) {
    console.error('Audit log read error:', error.message);
    res.status(500).json({ message: 'Unable to load audit log' });
  }
});

app.get('/api/dashboard', authenticate, (req, res) => {
  res.json({
    user: {
      id: req.user.sub,
      username: req.user.username,
      location: { latitude: 52.52, longitude: 13.405 },
      speed: 50
    },
    note: 'Demo GPS values; device API integration is the next milestone.'
  });
});

app.post('/api/v1/devices', authenticate, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const deviceId = String(req.body.device_id || `belabox_${crypto.randomUUID()}`).trim();

    if (!name) {
      return sendError(res, 400, 'DEVICE_NAME_REQUIRED', 'Device name is required');
    }
    if (!/^[a-zA-Z0-9_-]{3,100}$/.test(deviceId)) {
      return sendError(res, 400, 'DEVICE_ID_INVALID', 'device_id may contain letters, digits, underscores and hyphens');
    }

    const deviceKey = `dkey_${crypto.randomBytes(32).toString('base64url')}`;
    const deviceKeyHash = await bcrypt.hash(deviceKey, 12);
    const result = await pool.query(
      `INSERT INTO devices (device_id, name, device_key_hash, owner_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, device_id, name, status, created_at`,
      [deviceId, name, deviceKeyHash, req.user.sub]
    );
    await recordAudit(req, 'device.created', 'device', deviceId, { name });

    res.status(201).json({
      device: result.rows[0],
      device_key: deviceKey,
      warning: 'Save device_key now. It is shown only once and cannot be recovered.'
    });
  } catch (error) {
    if (error.code === '23505') {
      return sendError(res, 409, 'DEVICE_ID_EXISTS', 'This device_id already exists');
    }
    console.error('Create device error:', error.message);
    sendError(res, 500, 'DEVICE_CREATE_FAILED', 'Unable to create device');
  }
});

app.get('/api/v1/devices', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, device_id, name, status, created_at, last_seen_at,
              last_latitude, last_longitude, last_altitude, last_speed,
              last_heading, last_accuracy, last_satellites, last_recorded_at
       FROM devices
       WHERE owner_id = $1
       ORDER BY created_at DESC`,
      [req.user.sub]
    );
    res.json({ devices: result.rows });
  } catch (error) {
    console.error('List devices error:', error.message);
    sendError(res, 500, 'DEVICE_LIST_FAILED', 'Unable to list devices');
  }
});

app.get('/api/v1/devices/:deviceId', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, device_id, name, status, created_at, updated_at, last_seen_at,
              last_latitude, last_longitude, last_altitude, last_speed,
              last_heading, last_accuracy, last_satellites, last_recorded_at,
              public_share_id, public_share_enabled, public_share_updated_at
       FROM devices
       WHERE device_id = $1 AND owner_id = $2`,
      [req.params.deviceId, req.user.sub]
    );
    const device = result.rows[0];
    if (!device) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Unknown device');
    res.json({ device });
  } catch (error) {
    console.error('Get device error:', error.message);
    sendError(res, 500, 'DEVICE_READ_FAILED', 'Unable to load device');
  }
});

app.patch('/api/v1/devices/:deviceId/public-sharing', authenticate, async (req, res) => {
  try {
    if (typeof req.body.enabled !== 'boolean') {
      return sendError(res, 400, 'PUBLIC_SHARING_INVALID', 'enabled must be true or false');
    }
    const result = await pool.query(
      `UPDATE devices
       SET public_share_enabled = $1,
           public_share_id = CASE WHEN $1 AND public_share_id IS NULL THEN gen_random_uuid() ELSE public_share_id END,
           public_share_updated_at = NOW(), updated_at = NOW()
       WHERE device_id = $2 AND owner_id = $3 AND status = 'active'
       RETURNING device_id, public_share_id, public_share_enabled, public_share_updated_at`,
      [req.body.enabled, req.params.deviceId, req.user.sub]
    );
    const sharing = result.rows[0];
    if (!sharing) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Active device not found');
    await recordAudit(req, req.body.enabled ? 'public_sharing.enabled' : 'public_sharing.disabled', 'device', req.params.deviceId);
    res.json({ sharing, public_map_path: sharing.public_share_id ? `/map/${sharing.public_share_id}` : null });
  } catch (error) {
    console.error('Public sharing update error:', error.message);
    sendError(res, 500, 'PUBLIC_SHARING_UPDATE_FAILED', 'Unable to update public location sharing');
  }
});

app.post('/api/v1/devices/:deviceId/public-sharing/rotate', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE devices SET public_share_id = gen_random_uuid(), public_share_updated_at = NOW(), updated_at = NOW()
       WHERE device_id = $1 AND owner_id = $2 AND status = 'active'
       RETURNING device_id, public_share_id, public_share_enabled, public_share_updated_at`,
      [req.params.deviceId, req.user.sub]
    );
    const sharing = result.rows[0];
    if (!sharing) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Active device not found');
    await recordAudit(req, 'public_sharing.link_regenerated', 'device', req.params.deviceId);
    res.json({ sharing, public_map_path: `/map/${sharing.public_share_id}` });
  } catch (error) {
    console.error('Public sharing link regeneration error:', error.message);
    sendError(res, 500, 'PUBLIC_SHARING_ROTATE_FAILED', 'Unable to regenerate public map link');
  }
});

app.get('/api/v1/public-maps/:shareId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT name, status, last_seen_at, last_latitude, last_longitude,
              last_altitude, last_speed, last_heading, last_accuracy,
              last_satellites, last_recorded_at
       FROM devices
       WHERE public_share_id = $1 AND public_share_enabled = TRUE AND status = 'active'`,
      [req.params.shareId]
    );
    const device = result.rows[0];
    if (!device) return sendError(res, 404, 'PUBLIC_MAP_UNAVAILABLE', 'Location sharing is unavailable');
    res.set('Cache-Control', 'no-store');
    res.json({ device: overlayDeviceData({ ...device, device_id: undefined }) });
  } catch (error) {
    if (error.code === '22P02') return sendError(res, 404, 'PUBLIC_MAP_UNAVAILABLE', 'Location sharing is unavailable');
    console.error('Public map error:', error.message);
    sendError(res, 500, 'PUBLIC_MAP_FAILED', 'Unable to load the public map');
  }
});

app.get('/api/v1/devices/:deviceId/location', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT device_id, name, status, last_seen_at, last_latitude, last_longitude,
              last_altitude, last_speed, last_heading, last_accuracy,
              last_satellites, last_recorded_at
       FROM devices WHERE device_id = $1 AND owner_id = $2`,
      [req.params.deviceId, req.user.sub]
    );
    const device = result.rows[0];
    if (!device) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Unknown device');
    res.json({ device });
  } catch (error) {
    console.error('Get device location error:', error.message);
    sendError(res, 500, 'DEVICE_LOCATION_FAILED', 'Unable to load device location');
  }
});

app.get('/api/v1/devices/:deviceId/history', authenticate, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 1000, 1), 5000);
    const result = await pool.query(
      `SELECT p.latitude, p.longitude, p.altitude, p.speed, p.heading, p.accuracy,
              p.satellites, p.recorded_at, p.received_at
       FROM gps_positions p
       JOIN devices d ON d.id = p.device_id
       WHERE d.device_id = $1 AND d.owner_id = $2
         AND ($3::timestamptz IS NULL OR p.recorded_at >= $3)
         AND ($4::timestamptz IS NULL OR p.recorded_at <= $4)
       ORDER BY p.recorded_at ASC
       LIMIT $5`,
      [req.params.deviceId, req.user.sub, req.query.from || null, req.query.to || null, limit]
    );
    res.json({ positions: result.rows });
  } catch (error) {
    console.error('Get device history error:', error.message);
    sendError(res, 400, 'HISTORY_QUERY_INVALID', 'Invalid history query');
  }
});

app.get('/api/v1/devices/:deviceId/history/export', authenticate, async (req, res) => {
  try {
    const format = String(req.query.format || 'csv').toLowerCase();
    if (!['csv', 'gpx'].includes(format)) return sendError(res, 400, 'EXPORT_FORMAT_INVALID', 'Format must be csv or gpx');
    const result = await pool.query(
      `SELECT d.name, p.latitude, p.longitude, p.altitude, p.speed, p.heading,
              p.accuracy, p.satellites, p.recorded_at, p.received_at
       FROM gps_positions p JOIN devices d ON d.id = p.device_id
       WHERE d.device_id = $1 AND d.owner_id = $2
         AND ($3::timestamptz IS NULL OR p.recorded_at >= $3)
         AND ($4::timestamptz IS NULL OR p.recorded_at <= $4)
       ORDER BY p.recorded_at ASC LIMIT 100000`,
      [req.params.deviceId, req.user.sub, req.query.from || null, req.query.to || null]
    );
    const safeName = req.params.deviceId.replace(/[^a-zA-Z0-9_-]/g, '_');
    res.set('Cache-Control', 'no-store');
    if (format === 'csv') {
      const header = 'latitude,longitude,altitude,speed_kmh,heading,accuracy,satellites,recorded_at,received_at';
      const rows = result.rows.map((p) => [p.latitude, p.longitude, p.altitude, p.speed, p.heading, p.accuracy, p.satellites,
        new Date(p.recorded_at).toISOString(), new Date(p.received_at).toISOString()].map((v) => v ?? '').join(','));
      res.type('text/csv').attachment(`${safeName}-history.csv`).send([header, ...rows].join('\n'));
      return;
    }
    const points = result.rows.map((p) => `    <trkpt lat="${p.latitude}" lon="${p.longitude}">${p.altitude === null ? '' : `<ele>${p.altitude}</ele>`}<time>${new Date(p.recorded_at).toISOString()}</time></trkpt>`).join('\n');
    const name = escapeXml(result.rows[0]?.name || req.params.deviceId);
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Stream GPS" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>${name}</name><trkseg>\n${points}\n  </trkseg></trk>\n</gpx>`;
    res.type('application/gpx+xml').attachment(`${safeName}-history.gpx`).send(gpx);
  } catch (error) {
    console.error('History export error:', error.message);
    sendError(res, 400, 'HISTORY_EXPORT_FAILED', 'Unable to export GPS history');
  }
});

app.delete('/api/v1/devices/:deviceId/history', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM gps_positions p USING devices d
       WHERE p.device_id = d.id AND d.device_id = $1 AND d.owner_id = $2
       RETURNING p.id`,
      [req.params.deviceId, req.user.sub]
    );
    await pool.query(
      `DELETE FROM telemetry_sessions s USING devices d
       WHERE s.device_id = d.id AND d.device_id = $1 AND d.owner_id = $2`,
      [req.params.deviceId, req.user.sub]
    );
    await pool.query(
      `UPDATE devices SET last_seen_at = NULL, last_latitude = NULL, last_longitude = NULL,
       last_altitude = NULL, last_speed = NULL, last_heading = NULL, last_accuracy = NULL,
       last_satellites = NULL, last_recorded_at = NULL, updated_at = NOW()
       WHERE device_id = $1 AND owner_id = $2`,
      [req.params.deviceId, req.user.sub]
    );
    await recordAudit(req, 'device.history_deleted', 'device', req.params.deviceId, { deleted_points: result.rowCount });
    res.json({ message: 'GPS history deleted', deleted_points: result.rowCount });
  } catch (error) {
    console.error('History delete error:', error.message);
    sendError(res, 500, 'HISTORY_DELETE_FAILED', 'Unable to delete GPS history');
  }
});

app.post('/api/v1/devices/:deviceId/live-token', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT id FROM devices WHERE device_id = $1 AND owner_id = $2', [req.params.deviceId, req.user.sub]);
    if (!result.rows[0]) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Unknown device');
    const token = jwt.sign(
      { type: 'device-live', deviceDbId: result.rows[0].id }, process.env.JWT_SECRET,
      { algorithm: 'HS256', subject: req.user.sub, expiresIn: '5m' }
    );
    res.json({ token, expires_in: 300 });
  } catch (error) {
    console.error('Live token error:', error.message);
    sendError(res, 500, 'LIVE_TOKEN_FAILED', 'Unable to start live tracking');
  }
});

app.get('/api/v1/devices/:deviceId/live', async (req, res) => {
  try {
    const payload = jwt.verify(String(req.query.token || ''), process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (payload.type !== 'device-live') throw new Error('Wrong token type');
    const result = await pool.query(
      `SELECT id, device_id, name, status, last_seen_at, last_latitude, last_longitude,
              last_altitude, last_speed, last_heading, last_accuracy, last_satellites, last_recorded_at
       FROM devices WHERE id = $1 AND device_id = $2 AND owner_id = $3`,
      [payload.deviceDbId, req.params.deviceId, payload.sub]
    );
    const device = result.rows[0];
    if (!device) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Unknown device');
    res.status(200).set({ 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    if (!deviceStreams.has(device.id)) deviceStreams.set(device.id, new Set());
    deviceStreams.get(device.id).add(res);
    writeSse(res, 'ready', { device: overlayDeviceData({ ...device, latitude: device.last_latitude, longitude: device.last_longitude }) });
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat); const listeners = deviceStreams.get(device.id); listeners?.delete(res);
      if (listeners?.size === 0) deviceStreams.delete(device.id);
    });
  } catch {
    if (!res.headersSent) sendError(res, 401, 'LIVE_TOKEN_INVALID', 'Live tracking token is invalid or expired');
  }
});

app.post('/api/v1/devices/:deviceId/overlays', authenticate, async (req, res) => {
  try {
    const name = String(req.body.name || 'OBS overlay').trim();
    if (!name) return sendError(res, 400, 'OVERLAY_NAME_REQUIRED', 'Overlay name is required');

    const accessKey = `ovl_${crypto.randomBytes(32).toString('base64url')}`;
    const result = await pool.query(
      `INSERT INTO overlays (device_id, name, access_key_hash)
       SELECT id, $2, $3 FROM devices WHERE device_id = $1 AND owner_id = $4
       RETURNING id, name, status, created_at`,
      [req.params.deviceId, name, await bcrypt.hash(accessKey, 12), req.user.sub]
    );
    const overlay = result.rows[0];
    if (!overlay) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Unknown device');
    await recordAudit(req, 'overlay.created', 'overlay', overlay.id, { device_id: req.params.deviceId, name });

    res.status(201).json({
      overlay,
      access_key: accessKey,
      overlay_path: `/overlay/${overlay.id}?key=${encodeURIComponent(accessKey)}`,
      warning: 'Save this overlay URL now. The access key is shown only once.'
    });
  } catch (error) {
    console.error('Create overlay error:', error.message);
    sendError(res, 500, 'OVERLAY_CREATE_FAILED', 'Unable to create overlay');
  }
});

app.get('/api/v1/devices/:deviceId/overlays', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.name, o.status, o.created_at
       FROM overlays o JOIN devices d ON d.id = o.device_id
       WHERE d.device_id = $1 AND d.owner_id = $2 ORDER BY o.created_at DESC`,
      [req.params.deviceId, req.user.sub]
    );
    res.json({ overlays: result.rows });
  } catch (error) {
    console.error('List overlays error:', error.message);
    sendError(res, 500, 'OVERLAY_LIST_FAILED', 'Unable to list overlays');
  }
});

app.get('/api/v1/overlays/:overlayId', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.name, o.status, o.created_at, o.config, d.device_id
       FROM overlays o JOIN devices d ON d.id = o.device_id
       WHERE o.id = $1 AND d.owner_id = $2`,
      [req.params.overlayId, req.user.sub]
    );
    if (!result.rows[0]) return sendError(res, 404, 'OVERLAY_NOT_FOUND', 'Overlay not found');
    res.json({ overlay: { ...result.rows[0], config: normalizeOverlayConfig(result.rows[0].config) } });
  } catch (error) {
    console.error('Get overlay error:', error.message);
    sendError(res, 500, 'OVERLAY_READ_FAILED', 'Unable to load overlay');
  }
});

app.patch('/api/v1/overlays/:overlayId', authenticate, async (req, res) => {
  try {
    const config = validateOverlayConfig(req.body.config);
    if (!config) return sendError(res, 400, 'OVERLAY_CONFIG_INVALID', 'Invalid overlay configuration');
    const result = await pool.query(
      `UPDATE overlays o SET config = $2::jsonb, updated_at = NOW()
       FROM devices d
       WHERE o.id = $1 AND o.status = 'active' AND d.id = o.device_id AND d.owner_id = $3
       RETURNING o.id, o.name, o.status, o.config`,
      [req.params.overlayId, JSON.stringify(config), req.user.sub]
    );
    if (!result.rows[0]) return sendError(res, 404, 'OVERLAY_NOT_FOUND', 'Active overlay not found');
    publishOverlayEvent(req.params.overlayId, 'config', { config: result.rows[0].config });
    await recordAudit(req, 'overlay.updated', 'overlay', req.params.overlayId);
    res.json({ overlay: result.rows[0] });
  } catch (error) {
    console.error('Update overlay error:', error.message);
    sendError(res, 500, 'OVERLAY_UPDATE_FAILED', 'Unable to update overlay');
  }
});

app.post('/api/v1/overlays/:overlayId/revoke', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE overlays o SET status = 'revoked', updated_at = NOW()
       FROM devices d
       WHERE o.id = $1 AND o.status = 'active' AND d.id = o.device_id AND d.owner_id = $2
       RETURNING o.id, o.name, o.status`,
      [req.params.overlayId, req.user.sub]
    );
    if (!result.rows[0]) return sendError(res, 404, 'OVERLAY_NOT_FOUND', 'Active overlay not found');
    await recordAudit(req, 'overlay.revoked', 'overlay', req.params.overlayId);
    res.json({ overlay: result.rows[0] });
  } catch (error) {
    console.error('Revoke overlay error:', error.message);
    sendError(res, 500, 'OVERLAY_REVOKE_FAILED', 'Unable to revoke overlay');
  }
});

app.get('/api/v1/overlays/:overlayId/data', async (req, res) => {
  try {
    const key = String(req.query.key || '');
    if (!key) return sendError(res, 401, 'OVERLAY_KEY_REQUIRED', 'Overlay access key is required');
    const overlay = await getOverlayForPublicAccess(req.params.overlayId, key);
    if (!overlay) {
      return sendError(res, 404, 'OVERLAY_NOT_FOUND', 'Overlay not found');
    }
    res.set('Cache-Control', 'no-store');
    res.json({ config: normalizeOverlayConfig(overlay.config), device: overlayDeviceData(overlay) });
  } catch (error) {
    console.error('Overlay data error:', error.message);
    sendError(res, 500, 'OVERLAY_DATA_FAILED', 'Unable to load overlay data');
  }
});

app.get('/api/v1/overlays/:overlayId/stream', async (req, res) => {
  try {
    const key = String(req.query.key || '');
    if (!key) return sendError(res, 401, 'OVERLAY_KEY_REQUIRED', 'Overlay access key is required');
    const overlay = await getOverlayForPublicAccess(req.params.overlayId, key);
    if (!overlay) return sendError(res, 404, 'OVERLAY_NOT_FOUND', 'Overlay not found');

    res.status(200).set({
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    if (!overlayStreams.has(overlay.id)) overlayStreams.set(overlay.id, new Set());
    overlayStreams.get(overlay.id).add(res);
    writeSse(res, 'ready', { device: overlayDeviceData(overlay), config: normalizeOverlayConfig(overlay.config) });
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      const listeners = overlayStreams.get(overlay.id);
      listeners?.delete(res);
      if (listeners?.size === 0) overlayStreams.delete(overlay.id);
    });
  } catch (error) {
    console.error('Overlay stream error:', error.message);
    if (!res.headersSent) sendError(res, 500, 'OVERLAY_STREAM_FAILED', 'Unable to open overlay stream');
  }
});

app.post('/api/v1/devices/:deviceId/rotate-key', authenticate, async (req, res) => {
  try {
    const deviceKey = `dkey_${crypto.randomBytes(32).toString('base64url')}`;
    const result = await pool.query(
      `UPDATE devices SET device_key_hash = $1, updated_at = NOW()
       WHERE device_id = $2 AND owner_id = $3 AND status = 'active'
       RETURNING device_id, name`,
      [await bcrypt.hash(deviceKey, 12), req.params.deviceId, req.user.sub]
    );
    if (!result.rows[0]) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Active device not found');
    await recordAudit(req, 'device.key_replaced', 'device', req.params.deviceId);
    res.json({ device: result.rows[0], device_key: deviceKey, warning: 'Save device_key now. It is shown only once.' });
  } catch (error) {
    console.error('Rotate key error:', error.message);
    sendError(res, 500, 'DEVICE_KEY_ROTATION_FAILED', 'Unable to rotate device key');
  }
});

app.post('/api/v1/devices/:deviceId/revoke', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE devices SET status = 'revoked', updated_at = NOW()
       WHERE device_id = $1 AND owner_id = $2
       RETURNING device_id, name, status`,
      [req.params.deviceId, req.user.sub]
    );
    if (!result.rows[0]) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Unknown device');
    await recordAudit(req, 'device.revoked', 'device', req.params.deviceId);
    res.json({ device: result.rows[0] });
  } catch (error) {
    console.error('Revoke device error:', error.message);
    sendError(res, 500, 'DEVICE_REVOKE_FAILED', 'Unable to revoke device');
  }
});

app.delete('/api/v1/devices/:deviceId', authenticate, async (req, res) => {
  try {
    if (req.body.confirm_device_id !== req.params.deviceId) {
      return sendError(res, 400, 'DEVICE_DELETE_CONFIRMATION_REQUIRED', 'Enter the device ID to confirm permanent deletion');
    }
    const result = await pool.query(
      `DELETE FROM devices WHERE device_id = $1 AND owner_id = $2 RETURNING device_id, name`,
      [req.params.deviceId, req.user.sub]
    );
    if (!result.rows[0]) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Unknown device');
    await recordAudit(req, 'device.deleted', 'device', req.params.deviceId, { name: result.rows[0].name });
    res.json({ message: 'Device and all associated GPS data permanently deleted' });
  } catch (error) {
    console.error('Device delete error:', error.message);
    sendError(res, 500, 'DEVICE_DELETE_FAILED', 'Unable to delete device');
  }
});

app.post('/api/v1/gps/update', authenticateDevice, async (req, res) => {
  const validated = validateGpsPosition(req.body);
  if (validated.error) return sendError(res, 400, validated.error, validated.message);
  const { position } = validated;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM request_nonces WHERE expires_at <= NOW()');
    await client.query(
      `INSERT INTO request_nonces (nonce, device_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
      [req.requestNonce, req.device.id]
    );
    await client.query(
      `INSERT INTO gps_positions
       (device_id, latitude, longitude, altitude, speed, heading, accuracy, satellites, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [req.device.id, position.latitude, position.longitude, position.altitude ?? null,
        position.speed ?? null, position.heading ?? null, position.accuracy ?? null,
        position.satellites ?? null, position.recordedAt]
    );
    const sessionMetrics = await updateTelemetrySession(client, req.device, position);
    await client.query(
      `UPDATE devices SET last_seen_at = NOW(), updated_at = NOW(),
       last_latitude = $2, last_longitude = $3, last_altitude = $4, last_speed = $5,
       last_heading = $6, last_accuracy = $7, last_satellites = $8, last_recorded_at = $9
       WHERE id = $1`,
      [req.device.id, position.latitude, position.longitude, position.altitude ?? null,
        position.speed ?? null, position.heading ?? null, position.accuracy ?? null,
        position.satellites ?? null, position.recordedAt]
    );
    await client.query('COMMIT');
    res.status(201).json({ status: 'accepted', recorded_at: position.recordedAt.toISOString() });
    publishDevicePosition(req.device, position, sessionMetrics).catch((publishError) => {
      console.error('Overlay position publish error:', publishError.message);
    });
    runRetentionCleanup(req.device.owner_id).catch((cleanupError) => console.error('Retention cleanup error:', cleanupError.message));
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return sendError(res, 409, 'REQUEST_REPLAYED', 'This request nonce has already been used');
    }
    console.error('GPS update error:', error.message);
    sendError(res, 500, 'GPS_UPDATE_FAILED', 'Unable to store GPS update');
  } finally {
    client.release();
  }
});

app.listen(port, () => {
  console.log(`Backend running at http://localhost:${port}`);
});
