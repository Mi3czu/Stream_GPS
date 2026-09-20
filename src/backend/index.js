const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('./database/postgres');
const { authenticate } = require('./auth');
const { authenticateDevice, sendError } = require('./device-auth');

const app = express();
const port = Number(process.env.PORT || 3000);

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is required');
}

app.use(express.json());

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

app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({
        message: 'Username, email, and password are required'
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO admins (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email`,
      [username.trim(), email.trim().toLowerCase(), passwordHash]
    );

    res.status(201).json({
      message: 'User registered successfully',
      user: result.rows[0]
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        message: 'Username or email already exists'
      });
    }

    console.error('Registration error:', error.message);
    res.status(500).json({ message: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        message: 'Username and password are required'
      });
    }

    const result = await pool.query(
      `SELECT id, username, password_hash
       FROM admins
       WHERE username = $1`,
      [username.trim()]
    );
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        message: 'Invalid username or password'
      });
    }

    const token = jwt.sign(
      { username: user.username },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', subject: user.id, expiresIn: '1h' }
    );

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

app.get('/api/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email FROM admins WHERE id = $1',
      [req.user.sub]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ message: 'Administrator account no longer exists' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Current-user error:', error.message);
    res.status(500).json({ message: 'Unable to load current user' });
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
      `INSERT INTO devices (device_id, name, device_key_hash)
       VALUES ($1, $2, $3)
       RETURNING id, device_id, name, status, created_at`,
      [deviceId, name, deviceKeyHash]
    );

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
       ORDER BY created_at DESC`
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
              last_heading, last_accuracy, last_satellites, last_recorded_at
       FROM devices
       WHERE device_id = $1`,
      [req.params.deviceId]
    );
    const device = result.rows[0];
    if (!device) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Unknown device');
    res.json({ device });
  } catch (error) {
    console.error('Get device error:', error.message);
    sendError(res, 500, 'DEVICE_READ_FAILED', 'Unable to load device');
  }
});

app.get('/api/v1/devices/:deviceId/location', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT device_id, name, status, last_seen_at, last_latitude, last_longitude,
              last_altitude, last_speed, last_heading, last_accuracy,
              last_satellites, last_recorded_at
       FROM devices WHERE device_id = $1`,
      [req.params.deviceId]
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
       WHERE d.device_id = $1
         AND ($2::timestamptz IS NULL OR p.recorded_at >= $2)
         AND ($3::timestamptz IS NULL OR p.recorded_at <= $3)
       ORDER BY p.recorded_at ASC
       LIMIT $4`,
      [req.params.deviceId, req.query.from || null, req.query.to || null, limit]
    );
    res.json({ positions: result.rows });
  } catch (error) {
    console.error('Get device history error:', error.message);
    sendError(res, 400, 'HISTORY_QUERY_INVALID', 'Invalid history query');
  }
});

app.post('/api/v1/devices/:deviceId/rotate-key', authenticate, async (req, res) => {
  try {
    const deviceKey = `dkey_${crypto.randomBytes(32).toString('base64url')}`;
    const result = await pool.query(
      `UPDATE devices SET device_key_hash = $1, updated_at = NOW()
       WHERE device_id = $2 AND status = 'active'
       RETURNING device_id, name`,
      [await bcrypt.hash(deviceKey, 12), req.params.deviceId]
    );
    if (!result.rows[0]) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Active device not found');
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
       WHERE device_id = $1
       RETURNING device_id, name, status`,
      [req.params.deviceId]
    );
    if (!result.rows[0]) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Unknown device');
    res.json({ device: result.rows[0] });
  } catch (error) {
    console.error('Revoke device error:', error.message);
    sendError(res, 500, 'DEVICE_REVOKE_FAILED', 'Unable to revoke device');
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
