const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const validate = require('../middleware/validate');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { conflict, unauthorized } = require('../utils/errors');

const router = express.Router();

// Brute-force protection on credential endpoints (disabled under test).
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: { message: 'Too many attempts, please try again later' } },
});

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(255),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(72)
    .regex(/[A-Za-z]/, 'Password must contain a letter')
    .regex(/\d/, 'Password must contain a number'),
});
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

function signToken(user) {
  return jwt.sign({ sub: user.id }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    jwtid: crypto.randomUUID(),
  });
}

router.post(
  '/register',
  limiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw conflict('Email is already registered');
    }
    const hash = await bcrypt.hash(password, 12);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .run(name, email, hash);
    const user = { id: Number(lastInsertRowid), name, email };
    res.status(201).json({ user, token: signToken(user) });
  })
);

router.post(
  '/login',
  limiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Same error for unknown email and wrong password to avoid user enumeration.
    const ok = row && (await bcrypt.compare(password, row.password_hash));
    if (!ok) throw unauthorized('Invalid email or password');
    const user = { id: row.id, name: row.name, email: row.email };
    res.json({ user, token: signToken(user) });
  })
);

// Logout revokes the presented token until it would have expired anyway.
router.post('/logout', auth(), (req, res) => {
  const { jti, exp } = req.tokenPayload;
  db.prepare('INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)').run(jti, exp);
  // opportunistic cleanup of expired entries
  db.prepare('DELETE FROM revoked_tokens WHERE expires_at < ?').run(Math.floor(Date.now() / 1000));
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;
