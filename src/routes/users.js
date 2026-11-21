const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const db = require('../db');
const validate = require('../middleware/validate');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { conflict, unauthorized } = require('../utils/errors');

const router = express.Router();
router.use(auth());

const profile = (id) =>
  db.prepare('SELECT id, name, email, created_at, updated_at FROM users WHERE id = ?').get(id);

router.get('/me', (req, res) => res.json({ user: profile(req.user.id) }));

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().toLowerCase().email().max(255).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

router.patch(
  '/me',
  validate(updateSchema),
  (req, res) => {
    const { name, email } = req.body;
    if (email) {
      const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.id);
      if (taken) throw conflict('Email is already in use');
    }
    db.prepare(
      `UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(name ?? null, email ?? null, req.user.id);
    res.json({ user: profile(req.user.id) });
  }
);

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(72).regex(/[A-Za-z]/).regex(/\d/, 'Password must contain a number'),
});

router.put(
  '/me/password',
  validate(passwordSchema),
  asyncHandler(async (req, res) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!(await bcrypt.compare(req.body.currentPassword, row.password_hash))) {
      throw unauthorized('Current password is incorrect');
    }
    const hash = await bcrypt.hash(req.body.newPassword, 12);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(hash, req.user.id);
    res.json({ message: 'Password updated' });
  })
);

module.exports = router;
