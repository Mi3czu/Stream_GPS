const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { pool } = require('./database/postgres');
const { authenticate } = require('./auth');
const { authenticateDevice, sendError } = require('./device-auth');

const app = express();
const port = Number(process.env.PORT || 3000);
const overlayStreams = new Map();
const deviceStreams = new Map();
const publicMapStreams = new Map();
const publicMapCache = new Map();
const ADMIN_SESSION_HOURS = 8;
const LOGIN_WINDOW_MINUTES = 15;
const MAX_LOGIN_FAILURES = 5;
const MAX_GPS_SPEED_KMH = 500;
const MAX_GPS_PAST_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_GPS_FUTURE_MS = 5 * 60 * 1000;
const PASSWORD_RESET_TTL_MINUTES = 30;
const passwordResetCounters = new Map();

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is required');
}

const keyVaultKey = crypto.createHash('sha256').update(`stream-gps-key-vault:${process.env.JWT_SECRET}`).digest();

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyVaultKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

function decryptSecret(value) {
  if (!value) return null;
  try {
    const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyVaultKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function isPublicRateLimited(key, maxRequests, windowMs) {
  const now = Date.now();
  const current = passwordResetCounters.get(key);
  if (!current || current.resetAt <= now) {
    passwordResetCounters.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  current.count += 1;
  return current.count > maxRequests;
}

function passwordResetTokenHash(token) {
  return crypto.createHash('sha256').update(`stream-gps-password-reset:${token}`).digest('hex');
}

async function sendPasswordResetEmail({ email, username, resetUrl }) {
  if (process.env.SMTP_HOST && process.env.SMTP_FROM) {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined
    });
    await transport.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: 'Reset your Stream GPS password',
      text: `Hello ${username},\n\nReset your Stream GPS password within ${PASSWORD_RESET_TTL_MINUTES} minutes:\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
      html: `<p>Hello ${escapeXml(username)},</p><p>Reset your Stream GPS password within ${PASSWORD_RESET_TTL_MINUTES} minutes:</p><p><a href="${escapeXml(resetUrl)}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`
    });
    return;
  }
  if (process.env.NODE_ENV !== 'production') console.info(`Password reset link for ${email}: ${resetUrl}`);
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

function chatConfiguration(platform) {
  const upper = platform.toUpperCase();
  return {
    configured: Boolean(process.env[`${upper}_CLIENT_ID`] && process.env[`${upper}_CLIENT_SECRET`] && process.env.PUBLIC_BASE_URL),
    callback_path: `/api/v1/chat/${platform}/callback`
  };
}

const CHAT_COMMAND_DEFAULTS = [
  { action: 'map', label: 'Share viewer map', command: '!map', aliases: ['!mapa'], minimum_role: 'viewer', cooldown_seconds: 30, response_enabled: true },
  { action: 'gps_status', label: 'Show GPS status', command: '!gps', aliases: [], minimum_role: 'viewer', cooldown_seconds: 15, response_enabled: true },
  { action: 'private_mode', label: 'Hide viewer location', command: '!private', aliases: [], minimum_role: 'admin', cooldown_seconds: 0, response_enabled: true },
  { action: 'live_mode', label: 'Resume viewer location', command: '!live', aliases: [], minimum_role: 'owner', cooldown_seconds: 0, response_enabled: true },
  { action: 'hide_overlay', label: 'Hide OBS overlays', command: '!hidegps', aliases: [], minimum_role: 'moderator', cooldown_seconds: 0, response_enabled: true },
  { action: 'show_overlay', label: 'Show OBS overlays', command: '!showgps', aliases: [], minimum_role: 'admin', cooldown_seconds: 0, response_enabled: true },
  { action: 'panic', label: 'Emergency privacy stop', command: '!panic', aliases: ['!gpspanic'], minimum_role: 'admin', cooldown_seconds: 0, response_enabled: true }
];
const CHAT_COMMAND_ACTIONS = new Set(CHAT_COMMAND_DEFAULTS.map((rule) => rule.action));
const CHAT_ROLES = new Set(['viewer', 'moderator', 'admin', 'owner']);
const CHAT_COMMAND_PATTERN = /^![a-z0-9_-]{1,24}$/i;

async function ensureDeviceChatRules(deviceId) {
  for (const rule of CHAT_COMMAND_DEFAULTS) {
    await pool.query(
      `INSERT INTO device_chat_command_rules
       (device_id, action, command, aliases, minimum_role, cooldown_seconds, response_enabled)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       ON CONFLICT (device_id, action) DO NOTHING`,
      [deviceId, rule.action, rule.command, JSON.stringify(rule.aliases), rule.minimum_role, rule.cooldown_seconds, rule.response_enabled]
    );
  }
}

function validateChatCommandRule(action, input) {
  if (!CHAT_COMMAND_ACTIONS.has(action)) return null;
  const command = String(input.command || '').trim().toLowerCase();
  const aliases = Array.isArray(input.aliases) ? input.aliases.map((item) => String(item).trim().toLowerCase()).filter(Boolean) : null;
  const minimumRole = String(input.minimum_role || '');
  const cooldown = Number(input.cooldown_seconds);
  if (!CHAT_COMMAND_PATTERN.test(command) || !aliases || aliases.length > 4 || !aliases.every((alias) => CHAT_COMMAND_PATTERN.test(alias)) ||
      new Set([command, ...aliases]).size !== aliases.length + 1 || !CHAT_ROLES.has(minimumRole) ||
      !Number.isInteger(cooldown) || cooldown < 0 || cooldown > 3600 || typeof input.enabled !== 'boolean' || typeof input.response_enabled !== 'boolean') return null;
  // A public panic command would turn an anti-doxxing tool into a griefing tool.
  if (action === 'panic' && (!input.enabled || !['admin', 'owner'].includes(minimumRole))) return null;
  return { command, aliases, minimumRole, cooldown, enabled: input.enabled, responseEnabled: input.response_enabled };
}

// These endpoints deliberately only expose connection state. OAuth credentials
// remain server-side and integrations are inert until explicitly connected.
app.get('/api/v1/chat/integrations', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, platform, enabled, channel_id, channel_name, settings, created_at, updated_at
       FROM chat_integrations WHERE owner_id = $1 ORDER BY platform`, [req.user.sub]
    );
    const admins = await pool.query(
      `SELECT u.id, u.integration_id, u.platform_user_id, u.username, u.role
       FROM chat_authorized_users u JOIN chat_integrations i ON i.id = u.integration_id
       WHERE i.owner_id = $1 ORDER BY u.created_at`, [req.user.sub]
    );
    const integrations = ['kick', 'twitch'].map((platform) => ({
      platform, ...chatConfiguration(platform), integration: (() => {
        const integration = result.rows.find((row) => row.platform === platform);
        return integration ? { ...integration, authorized_users: admins.rows.filter((user) => user.integration_id === integration.id) } : null;
      })()
    }));
    res.json({ integrations });
  } catch (error) {
    console.error('Chat integrations read error:', error.message);
    sendError(res, 500, 'CHAT_INTEGRATIONS_READ_FAILED', 'Unable to load chat integrations');
  }
});

app.post('/api/v1/chat/integrations/:platform/admins', authenticate, async (req, res) => {
  const platform = String(req.params.platform || '').toLowerCase();
  const platformUserId = String(req.body.platform_user_id || '').trim();
  const username = String(req.body.username || '').trim();
  if (!['kick', 'twitch'].includes(platform)) return sendError(res, 404, 'CHAT_PLATFORM_UNKNOWN', 'Unknown chat platform');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(platformUserId) || (username && username.length > 100)) {
    return sendError(res, 400, 'CHAT_ADMIN_INVALID', 'A platform user ID is required and may only contain letters, numbers, underscores, and hyphens');
  }
  try {
    const integrationResult = await pool.query(
      `INSERT INTO chat_integrations (owner_id, platform)
       VALUES ($1, $2) ON CONFLICT (owner_id, platform) DO UPDATE SET updated_at = NOW()
       RETURNING id`, [req.user.sub, platform]
    );
    const result = await pool.query(
      `INSERT INTO chat_authorized_users (integration_id, platform_user_id, username, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (integration_id, platform_user_id) DO UPDATE SET username = EXCLUDED.username
       RETURNING id, integration_id, platform_user_id, username, role`,
      [integrationResult.rows[0].id, platformUserId, username || null]
    );
    await recordAudit(req, 'chat.admin.saved', 'chat_integration', platform, { platform_user_id: platformUserId });
    res.status(201).json({ admin: result.rows[0] });
  } catch (error) {
    console.error('Chat admin save error:', error.message);
    sendError(res, 500, 'CHAT_ADMIN_SAVE_FAILED', 'Unable to save trusted chat admin');
  }
});

app.delete('/api/v1/chat/integrations/:platform/admins/:adminId', authenticate, async (req, res) => {
  const platform = String(req.params.platform || '').toLowerCase();
  if (!['kick', 'twitch'].includes(platform)) return sendError(res, 404, 'CHAT_PLATFORM_UNKNOWN', 'Unknown chat platform');
  try {
    const result = await pool.query(
      `DELETE FROM chat_authorized_users u USING chat_integrations i
       WHERE u.id = $1 AND u.integration_id = i.id AND i.owner_id = $2 AND i.platform = $3
       RETURNING u.id`, [req.params.adminId, req.user.sub, platform]
    );
    if (!result.rows[0]) return sendError(res, 404, 'CHAT_ADMIN_NOT_FOUND', 'Trusted chat admin not found');
    await recordAudit(req, 'chat.admin.removed', 'chat_integration', platform);
    res.json({ message: 'Trusted chat admin removed' });
  } catch (error) {
    console.error('Chat admin delete error:', error.message);
    sendError(res, 500, 'CHAT_ADMIN_DELETE_FAILED', 'Unable to remove trusted chat admin');
  }
});

app.delete('/api/v1/chat/integrations/:platform', authenticate, async (req, res) => {
  const platform = String(req.params.platform || '').toLowerCase();
  if (!['kick', 'twitch'].includes(platform)) return sendError(res, 404, 'CHAT_PLATFORM_UNKNOWN', 'Unknown chat platform');
  try {
    await pool.query('DELETE FROM chat_integrations WHERE owner_id = $1 AND platform = $2', [req.user.sub, platform]);
    await recordAudit(req, 'chat.integration.disconnected', 'chat_integration', platform);
    res.json({ message: `${platform} integration disconnected` });
  } catch (error) {
    console.error('Chat integration disconnect error:', error.message);
    sendError(res, 500, 'CHAT_INTEGRATION_DISCONNECT_FAILED', 'Unable to disconnect chat integration');
  }
});

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
  mapOpacity: 100,
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
  const mapThemes = new Set(['standard', 'night', 'mono', 'dark', 'satellite']);
  const textThemes = new Set(['glass', 'light', 'dark']);
  const fonts = new Set(['monospace', 'Arial, sans-serif', 'Roboto, sans-serif', 'Inter, sans-serif', 'Oswald, sans-serif']);
  const color = /^#[0-9a-fA-F]{6}$/;

  const minSpeed = Number(config.minSpeed);
  const maxSpeed = Number(config.maxSpeed);
  const maxZoom = Number(config.maxZoom);
  const minZoom = Number(config.minZoom);
  const mapOpacity = Number(config.mapOpacity);
  if (!mapThemes.has(config.mapTheme) || !textThemes.has(config.textTheme) ||
      !fonts.has(config.fontFamily) || !['round', 'square'].includes(config.mapShape) ||
      !color.test(config.textColor) || !color.test(config.borderColor) ||
      !Number.isInteger(Number(config.mapSize)) || Number(config.mapSize) < 200 || Number(config.mapSize) > 600 ||
      !Number.isInteger(mapOpacity) || mapOpacity < 10 || mapOpacity > 100) {
    return null;
  }
  if (typeof config.autoZoom !== 'boolean' || !Number.isInteger(minSpeed) || !Number.isInteger(maxSpeed) ||
      !Number.isInteger(maxZoom) || !Number.isInteger(minZoom) || minSpeed < 0 || maxSpeed > 300 ||
      minSpeed >= maxSpeed || minZoom < 3 || maxZoom > 19 || minZoom >= maxZoom) return null;
  const statNames = Object.keys(DEFAULT_OVERLAY_CONFIG.stats);
  if (!statNames.every((name) => typeof config.stats[name] === 'boolean') ||
      !['above-map', 'below-map'].includes(config.statsPosition) ||
      !Number.isInteger(Number(config.statsTextSize)) || Number(config.statsTextSize) < 10 || Number(config.statsTextSize) > 28) return null;
  return { ...config, mapSize: Number(config.mapSize), mapOpacity, minSpeed, maxSpeed, minZoom, maxZoom, statsTextSize: Number(config.statsTextSize) };
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

function publishPublicMapEvent(shareId, event, data) {
  const listeners = publicMapStreams.get(String(shareId));
  if (!listeners) return;
  for (const response of listeners) writeSse(response, event, data);
}

function disablePublicMapShare(shareId) {
  if (!shareId) return;
  const key = String(shareId);
  publicMapCache.delete(key);
  const listeners = publicMapStreams.get(key);
  if (listeners) {
    for (const response of listeners) { writeSse(response, 'disabled', {}); response.end(); }
    publicMapStreams.delete(key);
  }
}

async function getPublicMapDevice(shareId) {
  const key = String(shareId);
  const cached = publicMapCache.get(key);
  if (cached) return cached;
  const result = await pool.query(
    `SELECT id, name, status, last_seen_at, last_latitude, last_longitude,
            last_altitude, last_speed, last_heading, last_accuracy,
            last_satellites, last_recorded_at
     FROM devices WHERE public_share_id = $1 AND public_share_enabled = TRUE AND status = 'active'`,
    [shareId]
  );
  const device = result.rows[0];
  if (!device) return null;
  const payload = overlayDeviceData({ ...device, device_id: undefined });
  publicMapCache.set(key, payload);
  return payload;
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function getOverlayForPublicAccess(overlayId, accessKey) {
  const result = await pool.query(
    `SELECT o.id, o.access_key_hash, o.access_key_encrypted, o.config, o.visible, d.name, d.device_id, d.status, d.last_seen_at,
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
  if (!overlay.access_key_encrypted) {
    await pool.query('UPDATE overlays SET access_key_encrypted = $2 WHERE id = $1 AND access_key_encrypted IS NULL', [overlay.id, encryptSecret(accessKey)]);
  }
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
  if (device.public_share_enabled && device.public_share_id) {
    const { device_id: ignoredDeviceId, ...publicPayload } = payload;
    const shareId = String(device.public_share_id);
    publicMapCache.set(shareId, publicPayload);
    publishPublicMapEvent(shareId, 'position', { device: publicPayload });
  }
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

  if (position.speed !== undefined && (position.speed < 0 || position.speed > MAX_GPS_SPEED_KMH)) {
    return { error: 'INVALID_SPEED', message: `speed must be between 0 and ${MAX_GPS_SPEED_KMH} km/h` };
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
  const timestampAge = position.recordedAt.getTime() - Date.now();
  if (timestampAge < -MAX_GPS_PAST_AGE_MS || timestampAge > MAX_GPS_FUTURE_MS) {
    return { error: 'GPS_TIMESTAMP_OUT_OF_RANGE', message: 'recorded_at is too old or too far in the future' };
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
      `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '013_password_reset_tokens.sql') AS migrations_ready`
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

app.post('/api/password-reset/request', async (req, res) => {
  const genericMessage = 'If that email belongs to an account, a password reset link has been sent.';
  const email = String(req.body.email || '').trim().toLowerCase();
  const ipKey = `reset-ip:${req.ip}`;
  const emailKey = `reset-email:${crypto.createHash('sha256').update(email).digest('hex')}`;
  if (isPublicRateLimited(ipKey, 10, 60 * 60 * 1000) || isPublicRateLimited(emailKey, 3, 60 * 60 * 1000)) {
    res.set('Retry-After', '3600');
    return res.status(429).json({ message: 'Too many password reset requests. Try again later.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(202).json({ message: genericMessage });
  try {
    const result = await pool.query('SELECT id, username, email FROM admins WHERE email = $1', [email]);
    const user = result.rows[0];
    if (user) {
      const token = crypto.randomBytes(32).toString('base64url');
      const baseUrl = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
      await pool.query('DELETE FROM password_reset_tokens WHERE admin_id = $1 OR expires_at <= NOW()', [user.id]);
      await pool.query(
        `INSERT INTO password_reset_tokens (admin_id, token_hash, expires_at, requested_ip)
         VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 minute'), $4)`,
        [user.id, passwordResetTokenHash(token), PASSWORD_RESET_TTL_MINUTES, req.ip]
      );
      try { await sendPasswordResetEmail({ email: user.email, username: user.username, resetUrl }); }
      catch (mailError) { console.error('Password reset email error:', mailError.message); }
      req.user = { sub: user.id };
      await recordAudit(req, 'account.password_reset_requested', 'account', user.id);
    }
    res.status(202).json({ message: genericMessage });
  } catch (error) {
    console.error('Password reset request error:', error.message);
    res.status(202).json({ message: genericMessage });
  }
});

app.post('/api/password-reset/confirm', async (req, res) => {
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (!token || password.length < 12) return res.status(400).json({ message: 'A valid reset link and a password of at least 12 characters are required.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reset = await client.query(
      `SELECT id, admin_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() FOR UPDATE`,
      [passwordResetTokenHash(token)]
    );
    if (!reset.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'This password reset link is invalid or has expired.' }); }
    const resetId = reset.rows[0].id;
    const adminId = reset.rows[0].admin_id;
    await client.query('UPDATE admins SET password_hash = $1, updated_at = NOW() WHERE id = $2', [await bcrypt.hash(password, 12), adminId]);
    await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [resetId]);
    await client.query('UPDATE admin_sessions SET revoked_at = NOW() WHERE admin_id = $1 AND revoked_at IS NULL', [adminId]);
    await client.query('COMMIT');
    req.user = { sub: adminId };
    await recordAudit(req, 'account.password_reset_completed', 'account', adminId);
    res.json({ message: 'Password updated. Please log in with your new password.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Password reset confirm error:', error.message);
    res.status(500).json({ message: 'Unable to reset password' });
  } finally { client.release(); }
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
      `INSERT INTO devices (device_id, name, device_key_hash, device_key_encrypted, owner_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, device_id, name, status, created_at`,
      [deviceId, name, deviceKeyHash, encryptSecret(deviceKey), req.user.sub]
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

app.get('/api/v1/devices/:deviceId/credentials', authenticate, async (req, res) => {
  try {
    const deviceResult = await pool.query(
      `SELECT id, device_id, device_key_encrypted FROM devices
       WHERE device_id = $1 AND owner_id = $2`,
      [req.params.deviceId, req.user.sub]
    );
    const device = deviceResult.rows[0];
    if (!device) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Unknown device');
    const overlayResult = await pool.query(
      `SELECT id, name, status, access_key_encrypted FROM overlays
       WHERE device_id = $1 ORDER BY created_at DESC`,
      [device.id]
    );
    res.set('Cache-Control', 'no-store');
    res.json({
      device_id: device.device_id,
      device_key: decryptSecret(device.device_key_encrypted),
      overlays: overlayResult.rows.map((overlay) => ({
        id: overlay.id, name: overlay.name, status: overlay.status,
        access_key: decryptSecret(overlay.access_key_encrypted)
      }))
    });
  } catch (error) {
    console.error('Credentials read error:', error.message);
    sendError(res, 500, 'CREDENTIALS_READ_FAILED', 'Unable to load credentials');
  }
});

app.get('/api/v1/devices/:deviceId/chat-commands', authenticate, async (req, res) => {
  try {
    const deviceResult = await pool.query('SELECT id FROM devices WHERE device_id = $1 AND owner_id = $2', [req.params.deviceId, req.user.sub]);
    const device = deviceResult.rows[0];
    if (!device) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Unknown device');
    await ensureDeviceChatRules(device.id);
    const result = await pool.query(
      `SELECT action, enabled, command, aliases, minimum_role, cooldown_seconds, response_enabled, updated_at
       FROM device_chat_command_rules WHERE device_id = $1`, [device.id]
    );
    const byAction = new Map(result.rows.map((rule) => [rule.action, rule]));
    res.json({ commands: CHAT_COMMAND_DEFAULTS.map(({ label, ...rule }) => ({ label, ...byAction.get(rule.action) })) });
  } catch (error) {
    console.error('Chat command rules read error:', error.message);
    sendError(res, 500, 'CHAT_COMMANDS_READ_FAILED', 'Unable to load chat command settings');
  }
});

app.patch('/api/v1/devices/:deviceId/chat-commands/:action', authenticate, async (req, res) => {
  const action = String(req.params.action || '');
  const rule = validateChatCommandRule(action, req.body);
  if (!rule) return sendError(res, 400, 'CHAT_COMMAND_INVALID', 'Invalid command settings. Panic must remain enabled and restricted to an admin or owner.');
  try {
    const deviceResult = await pool.query('SELECT id FROM devices WHERE device_id = $1 AND owner_id = $2', [req.params.deviceId, req.user.sub]);
    const device = deviceResult.rows[0];
    if (!device) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Unknown device');
    await ensureDeviceChatRules(device.id);
    const existingRules = await pool.query('SELECT action, command, aliases FROM device_chat_command_rules WHERE device_id = $1 AND action <> $2', [device.id, action]);
    const requestedNames = new Set([rule.command, ...rule.aliases]);
    const conflict = existingRules.rows.find((existing) => [existing.command, ...(Array.isArray(existing.aliases) ? existing.aliases : [])]
      .some((name) => requestedNames.has(String(name).toLowerCase())));
    if (conflict) return sendError(res, 409, 'CHAT_COMMAND_CONFLICT', `A command or alias is already used by ${conflict.action}`);
    const result = await pool.query(
      `UPDATE device_chat_command_rules
       SET enabled = $3, command = $4, aliases = $5::jsonb, minimum_role = $6, cooldown_seconds = $7,
           response_enabled = $8, updated_at = NOW()
       WHERE device_id = $1 AND action = $2
       RETURNING action, enabled, command, aliases, minimum_role, cooldown_seconds, response_enabled, updated_at`,
      [device.id, action, rule.enabled, rule.command, JSON.stringify(rule.aliases), rule.minimumRole, rule.cooldown, rule.responseEnabled]
    );
    await recordAudit(req, 'chat.command.updated', 'device', req.params.deviceId, { action, command: rule.command, minimum_role: rule.minimumRole });
    res.json({ command: result.rows[0] });
  } catch (error) {
    console.error('Chat command rule update error:', error.message);
    sendError(res, 500, 'CHAT_COMMAND_UPDATE_FAILED', 'Unable to save chat command settings');
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
    if (sharing.public_share_enabled) publicMapCache.delete(String(sharing.public_share_id));
    else disablePublicMapShare(sharing.public_share_id);
    await recordAudit(req, req.body.enabled ? 'public_sharing.enabled' : 'public_sharing.disabled', 'device', req.params.deviceId);
    res.json({ sharing, public_map_path: sharing.public_share_id ? `/map/${sharing.public_share_id}` : null });
  } catch (error) {
    console.error('Public sharing update error:', error.message);
    sendError(res, 500, 'PUBLIC_SHARING_UPDATE_FAILED', 'Unable to update public location sharing');
  }
});

app.post('/api/v1/devices/:deviceId/public-sharing/rotate', authenticate, async (req, res) => {
  try {
    const previous = await pool.query('SELECT public_share_id FROM devices WHERE device_id = $1 AND owner_id = $2 AND status = $3', [req.params.deviceId, req.user.sub, 'active']);
    const result = await pool.query(
      `UPDATE devices SET public_share_id = gen_random_uuid(), public_share_updated_at = NOW(), updated_at = NOW()
       WHERE device_id = $1 AND owner_id = $2 AND status = 'active'
       RETURNING device_id, public_share_id, public_share_enabled, public_share_updated_at`,
      [req.params.deviceId, req.user.sub]
    );
    const sharing = result.rows[0];
    if (!sharing) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Active device not found');
    disablePublicMapShare(previous.rows[0]?.public_share_id);
    publicMapCache.delete(String(sharing.public_share_id));
    await recordAudit(req, 'public_sharing.link_regenerated', 'device', req.params.deviceId);
    res.json({ sharing, public_map_path: `/map/${sharing.public_share_id}` });
  } catch (error) {
    console.error('Public sharing link regeneration error:', error.message);
    sendError(res, 500, 'PUBLIC_SHARING_ROTATE_FAILED', 'Unable to regenerate public map link');
  }
});

app.get('/api/v1/public-maps/:shareId', async (req, res) => {
  try {
    const device = await getPublicMapDevice(req.params.shareId);
    if (!device) return sendError(res, 404, 'PUBLIC_MAP_UNAVAILABLE', 'Location sharing is unavailable');
    res.set('Cache-Control', 'no-store');
    res.json({ device });
  } catch (error) {
    if (error.code === '22P02') return sendError(res, 404, 'PUBLIC_MAP_UNAVAILABLE', 'Location sharing is unavailable');
    console.error('Public map error:', error.message);
    sendError(res, 500, 'PUBLIC_MAP_FAILED', 'Unable to load the public map');
  }
});

app.get('/api/v1/public-maps/:shareId/stream', async (req, res) => {
  try {
    const device = await getPublicMapDevice(req.params.shareId);
    if (!device) return sendError(res, 404, 'PUBLIC_MAP_UNAVAILABLE', 'Location sharing is unavailable');
    const shareId = String(req.params.shareId);
    res.status(200).set({
      'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
      'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    if (!publicMapStreams.has(shareId)) publicMapStreams.set(shareId, new Set());
    publicMapStreams.get(shareId).add(res);
    writeSse(res, 'ready', { device });
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      const listeners = publicMapStreams.get(shareId);
      listeners?.delete(res);
      if (listeners?.size === 0) publicMapStreams.delete(shareId);
    });
  } catch (error) {
    if (error.code === '22P02') return sendError(res, 404, 'PUBLIC_MAP_UNAVAILABLE', 'Location sharing is unavailable');
    console.error('Public map stream error:', error.message);
    if (!res.headersSent) sendError(res, 500, 'PUBLIC_MAP_STREAM_FAILED', 'Unable to open public map stream');
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
      `INSERT INTO overlays (device_id, name, access_key_hash, access_key_encrypted)
       SELECT id, $2, $3, $4 FROM devices WHERE device_id = $1 AND owner_id = $5
       RETURNING id, name, status, created_at`,
      [req.params.deviceId, name, await bcrypt.hash(accessKey, 12), encryptSecret(accessKey), req.user.sub]
    );
    const overlay = result.rows[0];
    if (!overlay) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Unknown device');
    await recordAudit(req, 'overlay.created', 'overlay', overlay.id, { device_id: req.params.deviceId, name });

    res.status(201).json({
      overlay,
      access_key: accessKey,
      overlay_path: `/overlay/${overlay.id}?key=${encodeURIComponent(accessKey)}`,
      warning: 'The complete OBS URL can also be retrieved later by the device owner.'
    });
  } catch (error) {
    console.error('Create overlay error:', error.message);
    sendError(res, 500, 'OVERLAY_CREATE_FAILED', 'Unable to create overlay');
  }
});

app.get('/api/v1/devices/:deviceId/overlays', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.name, o.status, o.visible, o.created_at
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
      `SELECT o.id, o.name, o.status, o.visible, o.created_at, o.config, d.device_id
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

app.patch('/api/v1/overlays/:overlayId/visibility', authenticate, async (req, res) => {
  if (typeof req.body.visible !== 'boolean') return sendError(res, 400, 'OVERLAY_VISIBILITY_INVALID', 'Visible must be true or false');
  try {
    const result = await pool.query(
      `UPDATE overlays o SET visible = $2, updated_at = NOW()
       FROM devices d WHERE o.id = $1 AND o.status = 'active' AND d.id = o.device_id AND d.owner_id = $3
       RETURNING o.id, o.name, o.status, o.visible`,
      [req.params.overlayId, req.body.visible, req.user.sub]
    );
    if (!result.rows[0]) return sendError(res, 404, 'OVERLAY_NOT_FOUND', 'Active overlay not found');
    publishOverlayEvent(req.params.overlayId, 'visibility', { visible: result.rows[0].visible });
    await recordAudit(req, req.body.visible ? 'overlay.shown' : 'overlay.hidden', 'overlay', req.params.overlayId);
    res.json({ overlay: result.rows[0] });
  } catch (error) {
    console.error('Overlay visibility error:', error.message);
    sendError(res, 500, 'OVERLAY_VISIBILITY_FAILED', 'Unable to change overlay visibility');
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

app.post('/api/v1/overlays/:overlayId/rotate-key', authenticate, async (req, res) => {
  try {
    const accessKey = `ovl_${crypto.randomBytes(32).toString('base64url')}`;
    const result = await pool.query(
      `UPDATE overlays o SET access_key_hash = $2, access_key_encrypted = $3, updated_at = NOW()
       FROM devices d
       WHERE o.id = $1 AND o.status = 'active' AND d.id = o.device_id AND d.owner_id = $4
       RETURNING o.id, o.name, o.status`,
      [req.params.overlayId, await bcrypt.hash(accessKey, 12), encryptSecret(accessKey), req.user.sub]
    );
    if (!result.rows[0]) return sendError(res, 404, 'OVERLAY_NOT_FOUND', 'Active overlay not found');
    await recordAudit(req, 'overlay.key_replaced', 'overlay', req.params.overlayId);
    res.json({ overlay: result.rows[0], access_key: accessKey });
  } catch (error) {
    console.error('Overlay key rotation error:', error.message);
    sendError(res, 500, 'OVERLAY_KEY_ROTATION_FAILED', 'Unable to replace overlay key');
  }
});

app.delete('/api/v1/overlays/:overlayId', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM overlays o USING devices d
       WHERE o.id = $1 AND d.id = o.device_id AND d.owner_id = $2
       RETURNING o.id, o.name`,
      [req.params.overlayId, req.user.sub]
    );
    if (!result.rows[0]) return sendError(res, 404, 'OVERLAY_NOT_FOUND', 'Overlay not found');
    const listeners = overlayStreams.get(req.params.overlayId);
    if (listeners) {
      for (const response of listeners) { writeSse(response, 'revoked', {}); response.end(); }
      overlayStreams.delete(req.params.overlayId);
    }
    await recordAudit(req, 'overlay.deleted', 'overlay', req.params.overlayId, { name: result.rows[0].name });
    res.json({ message: 'Overlay permanently deleted' });
  } catch (error) {
    console.error('Overlay delete error:', error.message);
    sendError(res, 500, 'OVERLAY_DELETE_FAILED', 'Unable to delete overlay');
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
    res.json({ config: normalizeOverlayConfig(overlay.config), visible: overlay.visible, device: overlayDeviceData(overlay) });
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
    writeSse(res, 'ready', { device: overlayDeviceData(overlay), config: normalizeOverlayConfig(overlay.config), visible: overlay.visible });
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
      `UPDATE devices SET device_key_hash = $1, device_key_encrypted = $2, updated_at = NOW()
       WHERE device_id = $3 AND owner_id = $4 AND status = 'active'
       RETURNING device_id, name`,
      [await bcrypt.hash(deviceKey, 12), encryptSecret(deviceKey), req.params.deviceId, req.user.sub]
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

app.get('/api/v1/device/public-sharing', authenticateDevice, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT public_share_id, public_share_enabled, public_share_updated_at
       FROM devices WHERE id = $1`,
      [req.device.id]
    );
    const sharing = result.rows[0];
    res.set('Cache-Control', 'no-store');
    res.json({ sharing, public_map_path: sharing.public_share_id ? `/map/${sharing.public_share_id}` : null });
  } catch (error) {
    console.error('Device public sharing read error:', error.message);
    sendError(res, 500, 'PUBLIC_SHARING_READ_FAILED', 'Unable to read public location sharing');
  }
});

app.patch('/api/v1/device/public-sharing', authenticateDevice, async (req, res) => {
  if (typeof req.body.enabled !== 'boolean') {
    return sendError(res, 400, 'PUBLIC_SHARING_INVALID', 'enabled must be true or false');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM request_nonces WHERE expires_at <= NOW()');
    await client.query(
      `INSERT INTO request_nonces (nonce, device_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
      [req.requestNonce, req.device.id]
    );
    const result = await client.query(
      `UPDATE devices
       SET public_share_enabled = $1,
           public_share_id = CASE WHEN $1 AND public_share_id IS NULL THEN gen_random_uuid() ELSE public_share_id END,
           public_share_updated_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND status = 'active'
       RETURNING device_id, public_share_id, public_share_enabled, public_share_updated_at`,
      [req.body.enabled, req.device.id]
    );
    await client.query('COMMIT');
    const sharing = result.rows[0];
    if (sharing.public_share_enabled) publicMapCache.delete(String(sharing.public_share_id));
    else disablePublicMapShare(sharing.public_share_id);
    await recordAudit(req, req.body.enabled ? 'public_sharing.device_enabled' : 'public_sharing.device_disabled', 'device', req.device.device_id);
    res.json({ sharing, public_map_path: sharing.public_share_id ? `/map/${sharing.public_share_id}` : null });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return sendError(res, 409, 'REQUEST_REPLAYED', 'This request nonce has already been used');
    console.error('Device public sharing update error:', error.message);
    sendError(res, 500, 'PUBLIC_SHARING_UPDATE_FAILED', 'Unable to update public location sharing');
  } finally {
    client.release();
  }
});

app.post('/api/v1/gps/update', authenticateDevice, async (req, res) => {
  const validated = validateGpsPosition(req.body);
  if (validated.error) return sendError(res, 400, validated.error, validated.message);
  const { position } = validated;
  if (req.device.last_recorded_at && position.recordedAt.getTime() <= new Date(req.device.last_recorded_at).getTime()) {
    return sendError(res, 409, 'GPS_POSITION_OUT_OF_ORDER', 'recorded_at must be newer than the last accepted position');
  }
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const latest = await client.query('SELECT last_recorded_at FROM devices WHERE id = $1 FOR UPDATE', [req.device.id]);
    if (latest.rows[0]?.last_recorded_at && position.recordedAt.getTime() <= new Date(latest.rows[0].last_recorded_at).getTime()) {
      await client.query('ROLLBACK');
      return sendError(res, 409, 'GPS_POSITION_OUT_OF_ORDER', 'recorded_at must be newer than the last accepted position');
    }
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
       last_heading = $6, last_accuracy = $7, last_satellites = $8, last_recorded_at = $9,
       device_key_encrypted = COALESCE(device_key_encrypted, $10)
       WHERE id = $1`,
      [req.device.id, position.latitude, position.longitude, position.altitude ?? null,
        position.speed ?? null, position.heading ?? null, position.accuracy ?? null,
        position.satellites ?? null, position.recordedAt, encryptSecret(req.deviceKey)]
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
