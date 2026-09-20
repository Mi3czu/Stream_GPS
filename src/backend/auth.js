const jwt = require('jsonwebtoken');
const { pool } = require('./database/postgres');

async function authenticate(req, res, next) {
  const authorization = req.get('Authorization');

  if (!authorization?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication token is required' });
  }

  try {
    const token = authorization.slice('Bearer '.length);
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!payload.sessionId) throw new Error('Token has no session');

    const result = await pool.query(
      `SELECT id FROM admin_sessions
       WHERE id = $1 AND admin_id = $2 AND revoked_at IS NULL AND expires_at > NOW()`,
      [payload.sessionId, payload.sub]
    );
    if (!result.rows[0]) throw new Error('Session is inactive');

    req.user = payload;
    req.sessionId = payload.sessionId;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid, expired, or revoked session' });
  }
}

module.exports = { authenticate };
