const db = require('../db');
const { notFound, forbidden } = require('../utils/errors');

const taskQuery = db.prepare(`
  SELECT t.* FROM tasks t
  WHERE t.id = @taskId AND (
    t.creator_id = @userId OR t.assignee_id = @userId OR
    t.team_id IN (SELECT team_id FROM team_members WHERE user_id = @userId)
  )`);
const viewableQuery = db.prepare(`
  SELECT t.* FROM tasks t
  WHERE t.id = @taskId AND (
    t.is_public = 1 OR t.creator_id = @userId OR t.assignee_id = @userId OR
    t.team_id IN (SELECT team_id FROM team_members WHERE user_id = @userId)
  )`);
const membership = db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?');
const teamById = db.prepare('SELECT * FROM teams WHERE id = ?');

/** Returns the task if the user can see it, else 404 (we don't leak existence). */
function getAccessibleTask(taskId, userId) {
  const task = taskQuery.get({ taskId, userId });
  if (!task) throw notFound('Task not found');
  return task;
}

/**
 * Like getAccessibleTask, but also allows ANY logged-in user to see public tasks.
 * Used for read + comment endpoints; edit/assign/delete still use getAccessibleTask.
 */
function getViewableTask(taskId, userId) {
  const task = viewableQuery.get({ taskId, userId });
  if (!task) throw notFound('Task not found');
  return task;
}

function getMembership(teamId, userId) {
  return membership.get(teamId, userId) || null;
}

/** Returns the team if the user is a member, else 404. */
function getTeamForMember(teamId, userId) {
  const team = teamById.get(teamId);
  if (!team || !getMembership(teamId, userId)) throw notFound('Team not found');
  return team;
}

/** Only the task creator or the team owner may delete a task. */
function assertCanDeleteTask(task, userId) {
  if (task.creator_id === userId) return;
  if (task.team_id && getMembership(task.team_id, userId)?.role === 'owner') return;
  throw forbidden('Only the task creator or team owner can delete this task');
}

module.exports = { getViewableTask, getAccessibleTask, getMembership, getTeamForMember, assertCanDeleteTask };
