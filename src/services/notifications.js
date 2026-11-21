const db = require('../db');

const insert = db.prepare(
  'INSERT INTO notifications (user_id, type, message, task_id) VALUES (?, ?, ?, ?)'
);
const getById = db.prepare('SELECT * FROM notifications WHERE id = ?');

// userId -> Set of open SSE responses (a user may have several tabs/devices)
const clients = new Map();

function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
}

function removeClient(userId, res) {
  const set = clients.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(userId);
}

/** Persist a notification and push it in real time to any open SSE streams. */
function notify(userId, type, message, taskId = null) {
  const { lastInsertRowid } = insert.run(userId, type, message, taskId);
  const notification = getById.get(lastInsertRowid);
  const set = clients.get(userId);
  if (set) {
    for (const res of set) res.write(`event: notification\ndata: ${JSON.stringify(notification)}\n\n`);
  }
  return notification;
}

/** Notify several users, skipping the actor and any duplicates. */
function notifyMany(userIds, actorId, type, message, taskId) {
  const unique = new Set(userIds.filter((id) => id && id !== actorId));
  unique.forEach((id) => notify(id, type, message, taskId));
}

module.exports = { addClient, removeClient, notify, notifyMany };
