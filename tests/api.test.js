// Integration tests - run with `npm test`. Uses an in-memory SQLite DB and a temp upload dir.
process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.UPLOAD_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'tm-'));
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';
process.env.COHERE_API_KEY = '';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');

const register = async (name, email) => {
  const res = await request(app).post('/api/auth/register').send({ name, email, password: 'Passw0rdX' });
  assert.equal(res.status, 201);
  return { token: res.body.token, id: res.body.user.id, h: { Authorization: `Bearer ${res.body.token}` } };
};

describe('TaskMaster API', () => {
  let alice, bob, carol, team, task;

  test('registration validates input and rejects duplicates', async () => {
    const bad = await request(app).post('/api/auth/register').send({ name: 'x', email: 'nope', password: '123' });
    assert.equal(bad.status, 400);
    alice = await register('Alice', 'alice@example.com');
    bob = await register('Bob', 'bob@example.com');
    carol = await register('Carol', 'carol@example.com');
    const dup = await request(app).post('/api/auth/register').send({ name: 'A', email: 'ALICE@example.com', password: 'Passw0rdX' });
    assert.equal(dup.status, 409);
  });

  test('login works and wrong password is rejected', async () => {
    const ok = await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'Passw0rdX' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    const bad = await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'wrong' });
    assert.equal(bad.status, 401);
  });

  test('protected routes require a token', async () => {
    assert.equal((await request(app).get('/api/tasks')).status, 401);
  });

  test('profile view and update', async () => {
    const me = await request(app).get('/api/users/me').set(alice.h);
    assert.equal(me.body.user.email, 'alice@example.com');
    assert.ok(!('password_hash' in me.body.user));
    const upd = await request(app).patch('/api/users/me').set(alice.h).send({ name: 'Alice A' });
    assert.equal(upd.body.user.name, 'Alice A');
  });

  test('team creation, joining by code, adding by email', async () => {
    const res = await request(app).post('/api/teams').set(alice.h).send({ name: 'Platform' });
    assert.equal(res.status, 201);
    team = res.body.team;
    assert.ok(team.invite_code);

    const join = await request(app).post('/api/teams/join').set(bob.h).send({ inviteCode: team.invite_code });
    assert.equal(join.status, 201);
    assert.equal(join.body.team.invite_code, undefined, 'non-owners must not see the invite code');

    const again = await request(app).post('/api/teams/join').set(bob.h).send({ inviteCode: team.invite_code });
    assert.equal(again.status, 409);

    const notOwner = await request(app).post(`/api/teams/${team.id}/members`).set(bob.h).send({ email: 'carol@example.com' });
    assert.equal(notOwner.status, 403);
  });

  test('task create, assign, and assignee validation', async () => {
    const res = await request(app).post('/api/tasks').set(alice.h).send({
      title: 'Write design doc', description: 'Covers the sync engine', dueDate: '2030-01-15', teamId: team.id, assigneeId: bob.id, priority: 'high',
    });
    assert.equal(res.status, 201);
    task = res.body.task;
    assert.equal(task.assignee.id, bob.id);
    assert.equal(task.dueDate, '2030-01-15T00:00:00.000Z');

    const outsider = await request(app).patch(`/api/tasks/${task.id}/assign`).set(alice.h).send({ assigneeId: carol.id });
    assert.equal(outsider.status, 400);

    const hidden = await request(app).get(`/api/tasks/${task.id}`).set(carol.h);
    assert.equal(hidden.status, 404);
  });

  test('assignee gets a persisted notification', async () => {
    const res = await request(app).get('/api/notifications').set(bob.h);
    assert.equal(res.body.unreadCount >= 1, true);
    assert.equal(res.body.notifications.some((n) => n.type === 'task_assigned'), true);
  });

  test('list, filter, search, sort', async () => {
    await request(app).post('/api/tasks').set(alice.h).send({ title: 'Personal errand', priority: 'low' });
    await request(app).post('/api/tasks').set(alice.h).send({ title: '100% coverage', dueDate: '2029-01-01' });

    const mine = await request(app).get('/api/tasks?assignee=me').set(bob.h);
    assert.equal(mine.body.tasks.length, 1);

    const search = await request(app).get('/api/tasks?q=sync').set(alice.h);
    assert.equal(search.body.tasks.length, 1);

    const literal = await request(app).get('/api/tasks?q=100%25').set(alice.h);
    assert.equal(literal.body.tasks.length, 1, 'LIKE wildcards must be escaped');

    const byDue = await request(app).get('/api/tasks?sortBy=dueDate&order=asc').set(alice.h);
    assert.equal(byDue.body.tasks[0].title, '100% coverage');
    assert.equal(byDue.body.tasks.at(-1).dueDate, null, 'null due dates sort last');

    const badSort = await request(app).get('/api/tasks?sortBy=password').set(alice.h);
    assert.equal(badSort.status, 400);
  });

  test('complete a task and filter by status', async () => {
    const done = await request(app).post(`/api/tasks/${task.id}/complete`).set(bob.h);
    assert.equal(done.body.task.status, 'completed');
    assert.ok(done.body.task.completedAt);
    const completed = await request(app).get('/api/tasks?status=completed').set(alice.h);
    assert.equal(completed.body.tasks.length, 1);
    const open = await request(app).get('/api/tasks?status=open').set(alice.h);
    assert.equal(open.body.tasks.every((t) => t.status === 'open'), true);
  });

  test('comments and attachments', async () => {
    // the task was completed in the previous test, so comments are closed until it is reopened
    const closed = await request(app).post(`/api/tasks/${task.id}/comments`).set(bob.h).send({ body: 'too late' });
    assert.equal(closed.status, 409);
    const reopen = await request(app).patch(`/api/tasks/${task.id}`).set(bob.h).send({ status: 'in_progress' });
    assert.equal(reopen.body.task.completedAt, null);

    const c = await request(app).post(`/api/tasks/${task.id}/comments`).set(bob.h).send({ body: 'On it!' });
    assert.equal(c.status, 201);
    const list = await request(app).get(`/api/tasks/${task.id}/comments`).set(alice.h);
    assert.equal(list.body.comments.length, 1);
    const forbidden = await request(app).delete(`/api/tasks/${task.id}/comments/${c.body.comment.id}`).set(alice.h);
    assert.equal(forbidden.status, 403);

    const up = await request(app).post(`/api/tasks/${task.id}/attachments`).set(bob.h).attach('file', Buffer.from('hello'), 'notes.txt');
    assert.equal(up.status, 201);
    const dl = await request(app).get(up.body.attachment.downloadUrl).set(alice.h);
    assert.equal(dl.status, 200);
    assert.equal(dl.text, 'hello');

    const denied = await request(app).post(`/api/tasks/${task.id}/attachments`).set(carol.h).attach('file', Buffer.from('x'), 'x.txt');
    assert.equal(denied.status, 404);
  });

  test('delete permissions', async () => {
    const res = await request(app).delete(`/api/tasks/${task.id}`).set(bob.h);
    assert.equal(res.status, 403);
    const ok = await request(app).delete(`/api/tasks/${task.id}`).set(alice.h);
    assert.equal(ok.status, 204);
  });

  test('AI description generation (template fallback)', async () => {
    const res = await request(app).post('/api/ai/task-description').set(alice.h).send({ prompt: 'fix login bug on mobile' });
    assert.equal(res.status, 200);
    assert.ok(res.body.title && res.body.description && Array.isArray(res.body.checklist));
  });

  test('logout invalidates the token', async () => {
    const out = await request(app).post('/api/auth/logout').set(carol.h);
    assert.equal(out.status, 200);
    const after = await request(app).get('/api/users/me').set(carol.h);
    assert.equal(after.status, 401);
  });
});

describe('Admin assignment, public tasks, completed-task comments', () => {
  let owner, member, stranger, team, personal, pub;
  const mk = async (n) => {
    const r = await request(app).post('/api/auth/register').send({ name: n, email: `${n}@x.com`, password: 'Passw0rdX' });
    return { id: r.body.user.id, h: { Authorization: `Bearer ${r.body.token}` } };
  };

  test('setup', async () => {
    owner = await mk('owner'); member = await mk('member'); stranger = await mk('stranger');
    team = (await request(app).post('/api/teams').set(owner.h).send({ name: 'T2' })).body.team;
    await request(app).post('/api/teams/join').set(member.h).send({ inviteCode: team.invite_code });
  });

  test('personal task cannot be assigned to others until moved into a team', async () => {
    personal = (await request(app).post('/api/tasks').set(owner.h).send({ title: 'Solo' })).body.task;
    const fail = await request(app).patch(`/api/tasks/${personal.id}/assign`).set(owner.h).send({ assigneeId: member.id });
    assert.equal(fail.status, 400);
    const move = await request(app).patch(`/api/tasks/${personal.id}`).set(owner.h).send({ teamId: team.id });
    assert.equal(move.body.task.teamId, team.id);
    const ok = await request(app).patch(`/api/tasks/${personal.id}/assign`).set(owner.h).send({ assigneeId: member.id });
    assert.equal(ok.body.task.assignee.id, member.id);
  });

  test('plain members can only assign to themselves', async () => {
    const other = (await request(app).post('/api/tasks').set(owner.h).send({ title: 'Team job', teamId: team.id })).body.task;
    const nope = await request(app).patch(`/api/tasks/${other.id}/assign`).set(member.h).send({ assigneeId: owner.id });
    assert.equal(nope.status, 403);
    const claim = await request(app).patch(`/api/tasks/${other.id}/assign`).set(member.h).send({ assigneeId: member.id });
    assert.equal(claim.status, 200);
  });

  test('public task: any user can read and comment, but not edit', async () => {
    pub = (await request(app).post('/api/tasks').set(owner.h).send({ title: 'Open question', isPublic: true })).body.task;
    assert.equal(pub.isPublic, true);
    assert.equal((await request(app).get(`/api/tasks/${pub.id}`).set(stranger.h)).status, 200);
    const c = await request(app).post(`/api/tasks/${pub.id}/comments`).set(stranger.h).send({ body: 'I have a doubt' });
    assert.equal(c.status, 201);
    assert.equal((await request(app).patch(`/api/tasks/${pub.id}`).set(stranger.h).send({ title: 'hax' })).status, 404);
    const feed = await request(app).get('/api/tasks?scope=public').set(stranger.h);
    assert.equal(feed.body.tasks.some((t) => t.id === pub.id), true);
    const mineOnly = await request(app).get('/api/tasks').set(stranger.h);
    assert.equal(mineOnly.body.tasks.length, 0);
  });

  test('private task stays hidden; completed public task closes comments', async () => {
    assert.equal((await request(app).get(`/api/tasks/${personal.id}`).set(stranger.h)).status, 404);
    await request(app).post(`/api/tasks/${pub.id}/complete`).set(owner.h);
    const late = await request(app).post(`/api/tasks/${pub.id}/comments`).set(stranger.h).send({ body: 'late' });
    assert.equal(late.status, 409);
  });
});

describe('Docs', () => {
  test('Swagger UI and OpenAPI JSON are served', async () => {
    const ui = await request(app).get('/api-docs/');
    assert.equal(ui.status, 200);
    const spec = await request(app).get('/api-docs.json');
    assert.equal(spec.body.openapi, '3.0.3');
    assert.ok(spec.body.paths['/tasks']);
  });
});

describe('AI providers (mocked network)', () => {
  const config = require('../src/config');
  const ai = require('../src/services/ai');
  const realFetch = global.fetch;
  const mock = (body) => { global.fetch = async (url) => { mock.url = url; return { ok: true, json: async () => body }; }; };
  const reset = () => { global.fetch = realFetch; config.ai.openrouterKey = ''; config.ai.cohereKey = ''; config.ai.provider = ''; };

  test('OpenRouter reply (JSON wrapped in prose) is parsed', async () => {
    config.ai.openrouterKey = 'k';
    mock({ choices: [{ message: { content: 'Sure!\n```json\n{"title":"Fix login","description":"Do it.","checklist":["a","b"]}\n```' } }] });
    const out = await ai.generateTaskDescription('fix login');
    assert.equal(out.source, 'ai');
    assert.equal(out.provider, 'openrouter');
    assert.match(mock.url, /openrouter\.ai/);
    assert.deepEqual(out.checklist, ['a', 'b']);
    reset();
  });

  test('Cohere v2 reply is parsed', async () => {
    config.ai.cohereKey = 'k';
    mock({ message: { content: [{ type: 'text', text: '{"title":"T","description":"D","checklist":[]}' }] } });
    const out = await ai.generateTaskDescription('anything');
    assert.equal(out.provider, 'cohere');
    assert.match(mock.url, /cohere\.com/);
    reset();
  });

  test('provider failure falls back to the template', async () => {
    config.ai.cohereKey = 'k';
    global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
    const out = await ai.generateTaskDescription('anything');
    assert.equal(out.source, 'template');
    reset();
  });
});
