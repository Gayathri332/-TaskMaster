const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { unauthorized } = require('../utils/errors');

const findUser = db.prepare('SELECT id, name, email FROM users WHERE id = ?');
const isRevoked = db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?');

/**
 * Requires a valid, non-revoked JWT in `Authorization: Bearer <token>`.
 * Pass { allowQueryToken: true } for SSE, since EventSource cannot set headers.
 */
module.exports = ({ allowQueryToken = false } = {}) =>
  asyncHandler(async (req, _res, next) => {
    const header = req.headers.authorization || '';
    let token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token && allowQueryToken && req.query.token) token = String(req.query.token);
    if (!token) throw unauthorized();

    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    if (isRevoked.get(payload.jti)) throw unauthorized('Token has been logged out');

    const user = findUser.get(payload.sub);
    if (!user) throw unauthorized('User no longer exists');

    req.user = user;
    req.tokenPayload = payload;
    next();
  });
