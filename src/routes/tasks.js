const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const validate = require('../middleware/validate');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { getAccessibleTask, getViewableTask, getMembership, assertCanDeleteTask } = require('../services/access');
const { notify, notifyMany } = require('../services/notifications');
const { summarizeTask } = require('../services/ai');
const { badRequest, notFound, forbidden, conflict } = require('../utils/errors');

const router = express.Router();
router.use(auth());

/* ----------------------------- schemas ----------------------------- */

const STATUSES = ['open', 'in_progress', 'completed'];
const PRIORITIES = ['low', 'medium', 'high'];

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Must be a valid ISO 8601 date')
  .transform((s) => new Date(s).toISOString());

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  dueDate: isoDate.nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(STATUSES).optional(),
  isPublic: z.boolean().optional(),
  teamId: z.number().int().positive().optional(),
  assigneeId: z.number().int().positive().nullable().optional(),
});

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).nullable(),
    dueDate: isoDate.nullable(),
    priority: z.enum(PRIORITIES),
    status: z.enum(STATUSES),
    isPublic: z.boolean(),
    teamId: z.number().int().positive(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const listSchema = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  teamId: z.coerce.number().int().positive().optional(),
  scope: z.enum(['mine', 'public']).default('mine'),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.coerce.number().int().positive()]).optional(),
  createdByMe: z.enum(['true', 'false']).optional(),
  dueBefore: isoDate.optional(),
  dueAfter: isoDate.optional(),
  q: z.string().trim().max(200).optional(),
  sortBy: z.enum(['createdAt', 'updatedAt', 'dueDate', 'priority', 'title', 'status']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

/* ----------------------------- helpers ----------------------------- */

const SORT_COLUMNS = {
  createdAt: 't.created_at',
  updatedAt: 't.updated_at',
  dueDate: 't.due_date',
  title: 't.title COLLATE NOCASE',
  status: 't.status',
  priority: "CASE t.priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END",
};

const TASK_SELECT = `
  SELECT t.*, a.name AS assignee_name, c.name AS creator_name, tm.name AS team_name,
    (SELECT COUNT(*) FROM comments WHERE task_id = t.id) AS comment_count,
    (SELECT COUNT(*) FROM attachments WHERE task_id = t.id) AS attachment_count
  FROM tasks t
  LEFT JOIN users a ON a.id = t.assignee_id
  JOIN users c ON c.id = t.creator_id
  LEFT JOIN teams tm ON tm.id = t.team_id`;

const toDto = (r) => ({
  id: r.id,
  title: r.title,
  description: r.description,
  status: r.status,
  priority: r.priority,
  isPublic: !!r.is_public,
  dueDate: r.due_date,
  teamId: r.team_id,
  teamName: r.team_name,
  creator: { id: r.creator_id, name: r.creator_name },
  assignee: r.assignee_id ? { id: r.assignee_id, name: r.assignee_name } : null,
  completedAt: r.completed_at,
  commentCount: r.comment_count,
  attachmentCount: r.attachment_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const loadDto = (id) => toDto(db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id));

/** The assignee must be a member of the task's team (or the creator for personal tasks). */
function assertValidAssignee(teamId, assigneeId, creatorId) {
  if (assigneeId == null) return;
  if (!teamId) {
    if (assigneeId !== creatorId) throw badRequest('This is a personal task (no team), so it can only be assigned to yourself. Move it into a team first with PATCH /tasks/{id} { "teamId": <your team id> }, then assign it');
    return;
  }
  if (!getMembership(teamId, assigneeId)) throw badRequest('Assignee must be a member of the task\'s team');
}

const touch = "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/* ------------------------------ tasks ------------------------------ */

router.post('/', validate(createSchema), (req, res) => {
  const b = req.body;
  if (b.teamId && !getMembership(b.teamId, req.user.id)) throw forbidden('You are not a member of that team');
  assertValidAssignee(b.teamId, b.assigneeId, req.user.id);

  const status = b.status ?? 'open';
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO tasks (title, description, status, priority, is_public, due_date, team_id, creator_id, assignee_id, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      b.title, b.description ?? null, status, b.priority ?? 'medium', b.isPublic ? 1 : 0, b.dueDate ?? null,
      b.teamId ?? null, req.user.id, b.assigneeId ?? null,
      status === 'completed' ? new Date().toISOString() : null
    );
  const task = loadDto(Number(lastInsertRowid));
  if (b.assigneeId) notifyMany([b.assigneeId], req.user.id, 'task_assigned', `${req.user.name} assigned you "${b.title}"`, task.id);
  res.status(201).json({ task });
});

router.get('/', validate(listSchema, 'query'), (req, res) => {
  const f = req.validQuery;
  // scope=mine (default): tasks I created, am assigned, or that belong to my teams.
  // scope=public: every task its owner marked public (anyone can read and comment on these).
  const where = [
    f.scope === 'public'
      ? '(t.is_public = 1 AND @me > 0)'
      : `(t.creator_id = @me OR t.assignee_id = @me OR t.team_id IN (SELECT team_id FROM team_members WHERE user_id = @me))`,
  ];
  const params = { me: req.user.id };

  if (f.status) { where.push('t.status = @status'); params.status = f.status; }
  if (f.priority) { where.push('t.priority = @priority'); params.priority = f.priority; }
  if (f.teamId) { where.push('t.team_id = @teamId'); params.teamId = f.teamId; }
  if (f.assignee === 'me') where.push('t.assignee_id = @me');
  else if (f.assignee === 'unassigned') where.push('t.assignee_id IS NULL');
  else if (f.assignee) { where.push('t.assignee_id = @assignee'); params.assignee = f.assignee; }
  if (f.createdByMe === 'true') where.push('t.creator_id = @me');
  if (f.dueBefore) { where.push('t.due_date <= @dueBefore'); params.dueBefore = f.dueBefore; }
  if (f.dueAfter) { where.push('t.due_date >= @dueAfter'); params.dueAfter = f.dueAfter; }
  if (f.q) {
    // Escape LIKE wildcards so user input is matched literally.
    where.push("(t.title LIKE @q ESCAPE '\\' OR t.description LIKE @q ESCAPE '\\')");
    params.q = `%${f.q.replace(/[\\%_]/g, '\\$&')}%`;
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks t ${whereSql}`).get(params).n;

  // NULL due dates always sort last; id is a stable tiebreaker.
  const nullsLast = f.sortBy === 'dueDate' ? 't.due_date IS NULL, ' : '';
  const rows = db
    .prepare(
      `${TASK_SELECT} ${whereSql}
       ORDER BY ${nullsLast}${SORT_COLUMNS[f.sortBy]} ${f.order === 'asc' ? 'ASC' : 'DESC'}, t.id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: f.limit, offset: (f.page - 1) * f.limit });

  res.json({
    tasks: rows.map(toDto),
    pagination: { page: f.page, limit: f.limit, total, totalPages: Math.ceil(total / f.limit) },
  });
});

router.get('/:id', validate(idParam, 'params'), (req, res) => {
  getViewableTask(req.params.id, req.user.id);
  res.json({ task: loadDto(req.params.id) });
});

router.patch('/:id', validate(idParam, 'params'), validate(updateSchema), (req, res) => {
  const task = getAccessibleTask(req.params.id, req.user.id);
  const b = req.body;

  // Moving a task into a team / changing visibility is limited to the creator (or the team owner).
  const isManager = task.creator_id === req.user.id || (task.team_id && getMembership(task.team_id, req.user.id)?.role === 'owner');
  if (('teamId' in b || 'isPublic' in b) && !isManager) {
    throw forbidden('Only the task creator or team owner can change the team or visibility');
  }
  if ('teamId' in b) {
    if (task.team_id && b.teamId !== task.team_id) throw badRequest('A task that already belongs to a team cannot be moved to another team');
    if (!getMembership(b.teamId, req.user.id)) throw forbidden('You are not a member of that team');
  }

  const status = b.status ?? task.status;
  const completedAt =
    status === 'completed' ? (task.completed_at ?? new Date().toISOString()) : null;

  db.prepare(
    `UPDATE tasks SET title = @title, description = @description, due_date = @dueDate,
       priority = @priority, status = @status, completed_at = @completedAt,
       team_id = @teamId, is_public = @isPublic, ${touch} WHERE id = @id`
  ).run({
    id: task.id,
    title: b.title ?? task.title,
    description: 'description' in b ? b.description : task.description,
    dueDate: 'dueDate' in b ? b.dueDate : task.due_date,
    priority: b.priority ?? task.priority,
    status,
    completedAt,
    teamId: b.teamId ?? task.team_id,
    isPublic: 'isPublic' in b ? (b.isPublic ? 1 : 0) : task.is_public,
  });

  const updated = loadDto(task.id);
  const verb = b.status && b.status !== task.status ? `changed "${task.title}" to ${b.status.replace('_', ' ')}` : `updated "${task.title}"`;
  notifyMany([task.assignee_id, task.creator_id], req.user.id, 'task_updated', `${req.user.name} ${verb}`, task.id);
  res.json({ task: updated });
});

// Convenience endpoint for user story 6.
router.post('/:id/complete', validate(idParam, 'params'), (req, res) => {
  const task = getAccessibleTask(req.params.id, req.user.id);
  if (task.status !== 'completed') {
    db.prepare(`UPDATE tasks SET status = 'completed', completed_at = ?, ${touch} WHERE id = ?`).run(new Date().toISOString(), task.id);
    notifyMany([task.assignee_id, task.creator_id], req.user.id, 'task_completed', `${req.user.name} completed "${task.title}"`, task.id);
  }
  res.json({ task: loadDto(task.id) });
});

router.patch(
  '/:id/assign',
  validate(idParam, 'params'),
  validate(z.object({ assigneeId: z.number().int().positive().nullable() })),
  (req, res) => {
    const task = getAccessibleTask(req.params.id, req.user.id);
    const { assigneeId } = req.body;
    assertValidAssignee(task.team_id, assigneeId, task.creator_id);

    // Team owner (admin) and the task creator can assign to anyone in the team.
    // Other members may only assign the task to themselves (claim it) or release it.
    const isManager = task.creator_id === req.user.id || (task.team_id && getMembership(task.team_id, req.user.id)?.role === 'owner');
    const selfOnly = assigneeId === req.user.id || (assigneeId === null && task.assignee_id === req.user.id);
    if (!isManager && !selfOnly) throw forbidden('Only the task creator or team owner can assign tasks to other people');

    db.prepare(`UPDATE tasks SET assignee_id = ?, ${touch} WHERE id = ?`).run(assigneeId, task.id);
    if (assigneeId && assigneeId !== task.assignee_id) {
      notifyMany([assigneeId], req.user.id, 'task_assigned', `${req.user.name} assigned you "${task.title}"`, task.id);
    }
    res.json({ task: loadDto(task.id) });
  }
);

router.delete('/:id', validate(idParam, 'params'), (req, res) => {
  const task = getAccessibleTask(req.params.id, req.user.id);
  assertCanDeleteTask(task, req.user.id);
  const files = db.prepare('SELECT stored_name FROM attachments WHERE task_id = ?').all(task.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id); // comments/attachments rows cascade
  files.forEach((f) => fs.rm(path.join(config.uploadDir, f.stored_name), { force: true }, () => {}));
  res.status(204).end();
});

router.post(
  '/:id/ai-summary',
  validate(idParam, 'params'),
  asyncHandler(async (req, res) => {
    const task = getAccessibleTask(req.params.id, req.user.id);
    const comments = db
      .prepare('SELECT c.body, u.name AS user_name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.task_id = ? ORDER BY c.id')
      .all(task.id);
    res.json(await summarizeTask(task, comments));
  })
);

/* ----------------------------- comments ---------------------------- */

const commentDto = (r) => ({ id: r.id, taskId: r.task_id, body: r.body, author: { id: r.user_id, name: r.user_name }, createdAt: r.created_at });
const COMMENT_SELECT = 'SELECT c.*, u.name AS user_name FROM comments c JOIN users u ON u.id = c.user_id';

router.post(
  '/:id/comments',
  validate(idParam, 'params'),
  validate(z.object({ body: z.string().trim().min(1).max(2000) })),
  (req, res) => {
    // Any logged-in user may comment on a public task; private tasks need access.
    const task = getViewableTask(req.params.id, req.user.id);
    if (task.status === 'completed') {
      throw conflict('This task is completed, so comments are closed. Reopen it (status "open" or "in_progress") to comment again');
    }
    const { lastInsertRowid } = db.prepare('INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)').run(task.id, req.user.id, req.body.body);
    notifyMany([task.assignee_id, task.creator_id], req.user.id, 'comment_added', `${req.user.name} commented on "${task.title}"`, task.id);
    res.status(201).json({ comment: commentDto(db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(lastInsertRowid)) });
  }
);

router.get('/:id/comments', validate(idParam, 'params'), (req, res) => {
  getViewableTask(req.params.id, req.user.id);
  const rows = db.prepare(`${COMMENT_SELECT} WHERE c.task_id = ? ORDER BY c.id`).all(req.params.id);
  res.json({ comments: rows.map(commentDto) });
});

router.delete(
  '/:id/comments/:commentId',
  validate(idParam.extend({ commentId: z.coerce.number().int().positive() }), 'params'),
  (req, res) => {
    const task = getViewableTask(req.params.id, req.user.id);
    const comment = db.prepare('SELECT * FROM comments WHERE id = ? AND task_id = ?').get(req.params.commentId, task.id);
    if (!comment) throw notFound('Comment not found');
    if (comment.user_id !== req.user.id) throw forbidden('You can only delete your own comments');
    db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id);
    res.status(204).end();
  }
);

/* --------------------------- attachments --------------------------- */

fs.mkdirSync(config.uploadDir, { recursive: true });

// Files are stored under random names; the original name is kept only as metadata.
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).slice(0, 10)}`),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

const attDto = (r) => ({
  id: r.id, taskId: r.task_id, fileName: r.original_name, mimeType: r.mime_type, size: r.size,
  uploadedBy: r.user_id, createdAt: r.created_at,
  downloadUrl: `/api/tasks/${r.task_id}/attachments/${r.id}/download`,
});

router.post('/:id/attachments', validate(idParam, 'params'), (req, res, next) => {
  try { getAccessibleTask(req.params.id, req.user.id); } catch (e) { return next(e); } // check access BEFORE saving a file
  upload.single('file')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return next(badRequest('Attach a file using the multipart field "file"'));
    const task = getAccessibleTask(req.params.id, req.user.id);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO attachments (task_id, user_id, original_name, stored_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)')
      .run(task.id, req.user.id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size);
    notifyMany([task.assignee_id, task.creator_id], req.user.id, 'attachment_added', `${req.user.name} attached "${req.file.originalname}" to "${task.title}"`, task.id);
    res.status(201).json({ attachment: attDto(db.prepare('SELECT * FROM attachments WHERE id = ?').get(lastInsertRowid)) });
  });
});

router.get('/:id/attachments', validate(idParam, 'params'), (req, res) => {
  getViewableTask(req.params.id, req.user.id);
  res.json({ attachments: db.prepare('SELECT * FROM attachments WHERE task_id = ? ORDER BY id').all(req.params.id).map(attDto) });
});

const attParams = idParam.extend({ attachmentId: z.coerce.number().int().positive() });

router.get('/:id/attachments/:attachmentId/download', validate(attParams, 'params'), (req, res) => {
  const task = getViewableTask(req.params.id, req.user.id);
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND task_id = ?').get(req.params.attachmentId, task.id);
  if (!att) throw notFound('Attachment not found');
  res.download(path.resolve(config.uploadDir, att.stored_name), att.original_name);
});

router.delete('/:id/attachments/:attachmentId', validate(attParams, 'params'), (req, res) => {
  const task = getAccessibleTask(req.params.id, req.user.id);
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND task_id = ?').get(req.params.attachmentId, task.id);
  if (!att) throw notFound('Attachment not found');
  if (att.user_id !== req.user.id && task.creator_id !== req.user.id) throw forbidden('Only the uploader or task creator can delete this attachment');
  db.prepare('DELETE FROM attachments WHERE id = ?').run(att.id);
  fs.rm(path.join(config.uploadDir, att.stored_name), { force: true }, () => {});
  res.status(204).end();
});

module.exports = router;
