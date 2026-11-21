const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const db = require('../db');
const validate = require('../middleware/validate');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { getTeamForMember, getMembership } = require('../services/access');
const { notify } = require('../services/notifications');
const { notFound, forbidden, conflict, badRequest } = require('../utils/errors');

const router = express.Router();
router.use(auth());

const idParam = z.object({ id: z.coerce.number().int().positive() });
const newCode = () => crypto.randomBytes(5).toString('hex'); // 10 hex chars

const members = (teamId) =>
  db
    .prepare(
      `SELECT u.id, u.name, u.email, m.role, m.joined_at
       FROM team_members m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ? ORDER BY m.joined_at`
    )
    .all(teamId);

// Invite codes are only shown to the owner.
const present = (team, userId) => {
  const { invite_code, ...rest } = team;
  return team.owner_id === userId ? { ...rest, invite_code } : rest;
};

const teamSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
});

router.post('/', validate(teamSchema), (req, res) => {
  const tx = db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO teams (name, description, owner_id, invite_code) VALUES (?, ?, ?, ?)')
      .run(req.body.name, req.body.description ?? null, req.user.id, newCode());
    db.prepare("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'owner')").run(
      lastInsertRowid,
      req.user.id
    );
    return Number(lastInsertRowid);
  });
  const id = tx();
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  res.status(201).json({ team: present(team, req.user.id), members: members(id) });
});

router.get('/', (req, res) => {
  const teams = db
    .prepare(
      `SELECT t.*, m.role AS my_role,
        (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS member_count
       FROM teams t JOIN team_members m ON m.team_id = t.id AND m.user_id = ?
       ORDER BY t.created_at DESC`
    )
    .all(req.user.id)
    .map((t) => ({ ...present(t, req.user.id), my_role: t.my_role, member_count: t.member_count }));
  res.json({ teams });
});

// Join with an invite code (registered before /:id so "join" is not parsed as an id).
router.post('/join', validate(z.object({ inviteCode: z.string().trim().min(1) })), (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE invite_code = ?').get(req.body.inviteCode);
  if (!team) throw notFound('Invalid invite code');
  if (getMembership(team.id, req.user.id)) throw conflict('You are already a member of this team');
  db.prepare("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'member')").run(team.id, req.user.id);
  notify(team.owner_id, 'team_joined', `${req.user.name} joined team "${team.name}"`);
  res.status(201).json({ team: present(team, req.user.id), members: members(team.id) });
});

router.get('/:id', validate(idParam, 'params'), (req, res) => {
  const team = getTeamForMember(req.params.id, req.user.id);
  res.json({ team: present(team, req.user.id), members: members(team.id) });
});

// Owner adds an existing user by email ("invite a team member").
router.post(
  '/:id/members',
  validate(idParam, 'params'),
  validate(z.object({ email: z.string().trim().toLowerCase().email() })),
  (req, res) => {
    const team = getTeamForMember(req.params.id, req.user.id);
    if (team.owner_id !== req.user.id) throw forbidden('Only the team owner can add members');
    const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(req.body.email);
    if (!user) throw notFound('No registered user with that email');
    if (getMembership(team.id, user.id)) throw conflict('User is already a member');
    db.prepare("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'member')").run(team.id, user.id);
    notify(user.id, 'team_invited', `${req.user.name} added you to team "${team.name}"`);
    res.status(201).json({ members: members(team.id) });
  }
);

// Owner can remove anyone (except themselves); a member can remove themselves (leave).
router.delete(
  '/:id/members/:userId',
  validate(idParam.extend({ userId: z.coerce.number().int().positive() }), 'params'),
  (req, res) => {
    const team = getTeamForMember(req.params.id, req.user.id);
    const { userId } = req.params;
    if (userId === team.owner_id) throw badRequest('The team owner cannot be removed; delete the team instead');
    if (userId !== req.user.id && team.owner_id !== req.user.id) {
      throw forbidden('Only the owner can remove other members');
    }
    const result = db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(team.id, userId);
    if (!result.changes) throw notFound('Member not found');
    // Unassign their open tasks in this team
    db.prepare("UPDATE tasks SET assignee_id = NULL WHERE team_id = ? AND assignee_id = ? AND status != 'completed'").run(team.id, userId);
    res.status(204).end();
  }
);

router.delete('/:id', validate(idParam, 'params'), (req, res) => {
  const team = getTeamForMember(req.params.id, req.user.id);
  if (team.owner_id !== req.user.id) throw forbidden('Only the team owner can delete the team');
  db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
  res.status(204).end();
});

module.exports = router;
