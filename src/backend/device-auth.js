const bcrypt = require('bcryptjs');
const { pool } = require('./database/postgres');

const REQUEST_WINDOW_SECONDS = 300;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 180;
const requestCounters = new Map();

function sendError(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function isRateLimited(deviceId) {
  const now = Date.now();
  const current = requestCounters.get(deviceId);

  if (!current || current.resetAt <= now) {
    requestCounters.set(deviceId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  current.count += 1;
  return current.count > RATE_LIMIT_MAX_REQUESTS;
}

async function authenticateDevice(req, res, next) {
  const deviceId = req.get('X-Device-Id');
  const authorization = req.get('Authorization');
  const timestamp = Number(req.get('X-Request-Timestamp'));
  const nonce = req.get('X-Request-Nonce');
  const now = Math.floor(Date.now() / 1000);

  if (!deviceId || !authorization?.startsWith('Bearer ') || !nonce) {
    return sendError(res, 401, 'DEVICE_AUTH_REQUIRED', 'Device credentials are required');
  }

  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > REQUEST_WINDOW_SECONDS) {
    return sendError(res, 401, 'REQUEST_TIMESTAMP_INVALID', 'Request timestamp is invalid or too old');
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)) {
    return sendError(res, 400, 'REQUEST_NONCE_INVALID', 'X-Request-Nonce must be a UUID');
  }

  if (isRateLimited(deviceId)) {
    return sendError(res, 429, 'RATE_LIMITED', 'Too many GPS updates; retry later');
  }

  try {
    const result = await pool.query(
      `SELECT id, device_id, name, status, device_key_hash, owner_id, public_share_id, public_share_enabled
       FROM devices
       WHERE device_id = $1`,
      [deviceId]
    );
    const device = result.rows[0];

    if (!device || device.status !== 'active') {
      return sendError(res, 401, 'DEVICE_NOT_AUTHORIZED', 'Unknown or inactive device');
    }

    const key = authorization.slice('Bearer '.length);
    if (!(await bcrypt.compare(key, device.device_key_hash))) {
      return sendError(res, 401, 'DEVICE_NOT_AUTHORIZED', 'Unknown or inactive device');
    }

    req.device = device;
    req.deviceKey = key;
    req.requestNonce = nonce;
    next();
  } catch (error) {
    console.error('Device authentication error:', error.message);
    sendError(res, 500, 'DEVICE_AUTH_FAILED', 'Unable to authenticate device');
  }
}

module.exports = { authenticateDevice, sendError };
