const express = require('express');
const { z } = require('zod');
const db = require('../db');
const auth = require('../middleware/auth');
const validate = require('../middleware/validate');
const { addClient, removeClient } = require('../services/notifications');
const { notFound } = require('../utils/errors');

const router = express.Router();

const dto = (n) => ({ id: n.id, type: n.type, message: n.message, taskId: n.task_id, read: !!n.is_read, createdAt: n.created_at });

// Server-Sent Events stream. Browsers' EventSource cannot send headers, so ?token= is accepted here only.
router.get('/stream', auth({ allowQueryToken: true }), (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`event: connected\ndata: ${JSON.stringify({ userId: req.user.id })}\n\n`);
  addClient(req.user.id, res);

  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(req.user.id, res);
  });
});

router.use(auth());

router.get(
  '/',
  validate(z.object({ unread: z.enum(['true', 'false']).optional() }), 'query'),
  (req, res) => {
    const onlyUnread = req.validQuery.unread === 'true';
    const rows = db
      .prepare(`SELECT * FROM notifications WHERE user_id = ? ${onlyUnread ? 'AND is_read = 0' : ''} ORDER BY id DESC LIMIT 100`)
      .all(req.user.id);
    const unreadCount = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id).n;
    res.json({ notifications: rows.map(dto), unreadCount });
  }
);

router.post('/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ message: 'All notifications marked as read' });
});

router.patch('/:id/read', validate(z.object({ id: z.coerce.number().int().positive() }), 'params'), (req, res) => {
  const result = db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!result.changes) throw notFound('Notification not found');
  res.json({ message: 'Marked as read' });
});

module.exports = router;
