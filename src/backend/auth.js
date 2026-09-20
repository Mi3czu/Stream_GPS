const jwt = require('jsonwebtoken');

function authenticate(req, res, next) {
  const authorization = req.get('Authorization');

  if (!authorization?.startsWith('Bearer ')) {
    return res.status(401).json({
      message: 'Authentication token is required'
    });
  }

  try {
    const token = authorization.slice('Bearer '.length);

    req.user = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256']
    });

    next();
  } catch {
    res.status(401).json({
      message: 'Invalid or expired token'
    });
  }
}

module.exports = { authenticate };