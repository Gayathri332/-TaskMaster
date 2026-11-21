// OpenAPI 3.0 description of the TaskMaster API, served as Swagger UI at /api-docs.
const bearer = [{ bearerAuth: [] }];
const json = (schema) => ({ 'application/json': { schema } });
const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const idParam = (name = 'id', description = 'Numeric id') => ({ name, in: 'path', required: true, schema: { type: 'integer' }, description });
const body = (schema, example) => ({ required: true, content: { 'application/json': { schema, ...(example && { example }) } } });
const ok = (description, schema) => ({ description, ...(schema && { content: json(schema) }) });
const errs = { 400: ok('Validation error', ref('Error')), 401: ok('Missing/invalid token', ref('Error')), 404: ok('Not found', ref('Error')) };
const obj = (properties, required) => ({ type: 'object', properties, ...(required && { required }) });
const str = { type: 'string' };
const int = { type: 'integer' };

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'TaskMaster API',
    version: '1.0.0',
    description:
      '**How to try it:** 1) `POST /auth/register` (or `/auth/login`) and copy the `token` from the response. ' +
      '2) Click **Authorize** (top right) and paste the token. 3) Call any endpoint with **Try it out**.\n\n' +
      'Suggested flow: register -> create team -> create task in team -> assign -> comment -> attach file -> complete.',
  },
  servers: [{ url: '/api' }],
  tags: ['Auth', 'Users', 'Teams', 'Tasks', 'Comments', 'Attachments', 'Notifications', 'AI'].map((name) => ({ name })),
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: obj({ error: obj({ message: str, details: { type: 'array', items: obj({ field: str, message: str }) } }) }),
      User: obj({ id: int, name: str, email: str }),
      AuthResponse: obj({ user: ref('User'), token: str }),
      Task: obj({
        id: int, title: str, description: { ...str, nullable: true },
        status: { type: 'string', enum: ['open', 'in_progress', 'completed'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        isPublic: { type: 'boolean' },
        dueDate: { ...str, format: 'date-time', nullable: true },
        teamId: { ...int, nullable: true }, teamName: { ...str, nullable: true },
        creator: obj({ id: int, name: str }), assignee: { ...obj({ id: int, name: str }), nullable: true },
        completedAt: { ...str, nullable: true }, commentCount: int, attachmentCount: int,
        createdAt: str, updatedAt: str,
      }),
      Comment: obj({ id: int, taskId: int, body: str, author: obj({ id: int, name: str }), createdAt: str }),
      Attachment: obj({ id: int, taskId: int, fileName: str, mimeType: str, size: int, uploadedBy: int, createdAt: str, downloadUrl: str }),
      Notification: obj({ id: int, type: str, message: str, taskId: { ...int, nullable: true }, read: { type: 'boolean' }, createdAt: str }),
    },
  },
  paths: {
    '/auth/register': { post: { tags: ['Auth'], summary: 'Create an account', requestBody: body(obj({ name: str, email: str, password: { ...str, description: 'min 8 chars, a letter and a number' } }, ['name', 'email', 'password']), { name: 'Alice', email: 'alice@example.com', password: 'Passw0rdX' }), responses: { 201: ok('Created', ref('AuthResponse')), 400: errs[400], 409: ok('Email taken', ref('Error')) } } },
    '/auth/login': { post: { tags: ['Auth'], summary: 'Log in and get a JWT', requestBody: body(obj({ email: str, password: str }, ['email', 'password']), { email: 'alice@example.com', password: 'Passw0rdX' }), responses: { 200: ok('OK', ref('AuthResponse')), 401: errs[401] } } },
    '/auth/logout': { post: { tags: ['Auth'], summary: 'Log out (revokes the current token)', security: bearer, responses: { 200: ok('Logged out'), 401: errs[401] } } },

    '/users/me': {
      get: { tags: ['Users'], summary: 'View my profile', security: bearer, responses: { 200: ok('Profile', obj({ user: ref('User') })), 401: errs[401] } },
      patch: { tags: ['Users'], summary: 'Update my name/email', security: bearer, requestBody: body(obj({ name: str, email: str })), responses: { 200: ok('Updated', obj({ user: ref('User') })), 400: errs[400], 409: ok('Email in use', ref('Error')) } },
    },
    '/users/me/password': { put: { tags: ['Users'], summary: 'Change password', security: bearer, requestBody: body(obj({ currentPassword: str, newPassword: str }, ['currentPassword', 'newPassword'])), responses: { 200: ok('Updated'), 401: errs[401] } } },

    '/teams': {
      post: { tags: ['Teams'], summary: 'Create a team (you become owner)', security: bearer, requestBody: body(obj({ name: str, description: str }, ['name']), { name: 'Platform', description: 'Core services' }), responses: { 201: ok('Created'), 400: errs[400] } },
      get: { tags: ['Teams'], summary: 'List my teams', security: bearer, responses: { 200: ok('Teams') } },
    },
    '/teams/join': { post: { tags: ['Teams'], summary: 'Join a team with an invite code', security: bearer, requestBody: body(obj({ inviteCode: str }, ['inviteCode'])), responses: { 201: ok('Joined'), 404: errs[404], 409: ok('Already a member', ref('Error')) } } },
    '/teams/{id}': {
      get: { tags: ['Teams'], summary: 'Team details and members', security: bearer, parameters: [idParam()], responses: { 200: ok('Team'), 404: errs[404] } },
      delete: { tags: ['Teams'], summary: 'Delete team (owner only)', security: bearer, parameters: [idParam()], responses: { 204: ok('Deleted'), 403: ok('Not owner', ref('Error')) } },
    },
    '/teams/{id}/members': { post: { tags: ['Teams'], summary: 'Owner adds a registered user by email', security: bearer, parameters: [idParam()], requestBody: body(obj({ email: str }, ['email'])), responses: { 201: ok('Added'), 403: ok('Not owner', ref('Error')), 404: errs[404], 409: ok('Already a member', ref('Error')) } } },
    '/teams/{id}/members/{userId}': { delete: { tags: ['Teams'], summary: 'Remove a member / leave the team', security: bearer, parameters: [idParam(), idParam('userId')], responses: { 204: ok('Removed'), 403: ok('Forbidden', ref('Error')) } } },

    '/tasks': {
      post: { tags: ['Tasks'], summary: 'Create a task', security: bearer, requestBody: body(obj({ title: str, description: str, dueDate: { ...str, format: 'date-time' }, priority: { type: 'string', enum: ['low', 'medium', 'high'] }, status: { type: 'string', enum: ['open', 'in_progress', 'completed'] }, isPublic: { type: 'boolean', description: 'Public tasks can be read and commented on by any logged-in user' }, teamId: { ...int, description: 'Required if you want to assign the task to other people' }, assigneeId: int }, ['title']), { title: 'Write design doc', description: 'Covers the sync engine', dueDate: '2030-01-15', priority: 'high', teamId: 1, isPublic: false }), responses: { 201: ok('Created', obj({ task: ref('Task') })), 400: errs[400], 403: ok('Not a team member', ref('Error')) } },
      get: {
        tags: ['Tasks'], summary: 'List/filter/search/sort tasks visible to me', security: bearer,
        description: '`scope=mine` (default) = my tasks; `scope=public` = all public tasks (anyone can read/comment). "Tasks assigned to me": `assignee=me`. "Open tasks": `status=open`. Search: `q=keyword`.',
        parameters: [
          { name: 'scope', in: 'query', schema: { type: 'string', enum: ['mine', 'public'], default: 'mine' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'in_progress', 'completed'] } },
          { name: 'priority', in: 'query', schema: { type: 'string', enum: ['low', 'medium', 'high'] } },
          { name: 'teamId', in: 'query', schema: int },
          { name: 'assignee', in: 'query', schema: str, description: '`me`, `unassigned`, or a user id' },
          { name: 'createdByMe', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'dueBefore', in: 'query', schema: str }, { name: 'dueAfter', in: 'query', schema: str },
          { name: 'q', in: 'query', schema: str, description: 'Search title and description' },
          { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['createdAt', 'updatedAt', 'dueDate', 'priority', 'title', 'status'], default: 'createdAt' } },
          { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
        ],
        responses: { 200: ok('Tasks + pagination', obj({ tasks: { type: 'array', items: ref('Task') }, pagination: obj({ page: int, limit: int, total: int, totalPages: int }) })), 400: errs[400] },
      },
    },
    '/tasks/{id}': {
      get: { tags: ['Tasks'], summary: 'Get a task', security: bearer, parameters: [idParam()], responses: { 200: ok('Task', obj({ task: ref('Task') })), 404: errs[404] } },
      patch: { tags: ['Tasks'], summary: 'Update a task (also: move a personal task into a team via teamId, or make it public)', security: bearer, parameters: [idParam()], requestBody: body(obj({ title: str, description: str, dueDate: str, priority: str, teamId: int, isPublic: { type: 'boolean' }, status: { type: 'string', enum: ['open', 'in_progress', 'completed'] } }), { status: 'in_progress' }), responses: { 200: ok('Updated', obj({ task: ref('Task') })), 400: errs[400], 404: errs[404] } },
      delete: { tags: ['Tasks'], summary: 'Delete a task (creator or team owner)', security: bearer, parameters: [idParam()], responses: { 204: ok('Deleted'), 403: ok('Forbidden', ref('Error')) } },
    },
    '/tasks/{id}/complete': { post: { tags: ['Tasks'], summary: 'Mark task completed', security: bearer, parameters: [idParam()], responses: { 200: ok('Task', obj({ task: ref('Task') })) } } },
    '/tasks/{id}/assign': { patch: { tags: ['Tasks'], summary: 'Assign to a team member (null to unassign). Team owner/creator can assign anyone; other members only themselves. Personal tasks must be moved into a team first.', security: bearer, parameters: [idParam()], requestBody: body(obj({ assigneeId: { ...int, nullable: true } }, ['assigneeId']), { assigneeId: 2 }), responses: { 200: ok('Task', obj({ task: ref('Task') })), 400: ok('Assignee not in team', ref('Error')) } } },
    '/tasks/{id}/ai-summary': { post: { tags: ['AI'], summary: 'AI summary of a task and its comments', security: bearer, parameters: [idParam()], responses: { 200: ok('Summary', obj({ summary: str, source: str })) } } },

    '/tasks/{id}/comments': {
      post: { tags: ['Comments'], summary: 'Add a comment (any logged-in user on public tasks; closed once the task is completed)', security: bearer, parameters: [idParam()], requestBody: body(obj({ body: str }, ['body']), { body: 'On it!' }), responses: { 201: ok('Created', obj({ comment: ref('Comment') })), 409: ok('Task is completed - comments closed', ref('Error')) } },
      get: { tags: ['Comments'], summary: 'List comments', security: bearer, parameters: [idParam()], responses: { 200: ok('Comments', obj({ comments: { type: 'array', items: ref('Comment') } })) } },
    },
    '/tasks/{id}/comments/{commentId}': { delete: { tags: ['Comments'], summary: 'Delete my comment', security: bearer, parameters: [idParam(), idParam('commentId')], responses: { 204: ok('Deleted'), 403: ok('Not the author', ref('Error')) } } },

    '/tasks/{id}/attachments': {
      post: { tags: ['Attachments'], summary: 'Upload a file (max 5 MB)', security: bearer, parameters: [idParam()], requestBody: { required: true, content: { 'multipart/form-data': { schema: obj({ file: { type: 'string', format: 'binary' } }, ['file']) } } }, responses: { 201: ok('Uploaded', obj({ attachment: ref('Attachment') })), 400: errs[400] } },
      get: { tags: ['Attachments'], summary: 'List attachments', security: bearer, parameters: [idParam()], responses: { 200: ok('Attachments', obj({ attachments: { type: 'array', items: ref('Attachment') } })) } },
    },
    '/tasks/{id}/attachments/{attachmentId}/download': { get: { tags: ['Attachments'], summary: 'Download a file', security: bearer, parameters: [idParam(), idParam('attachmentId')], responses: { 200: { description: 'File', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } } } },
    '/tasks/{id}/attachments/{attachmentId}': { delete: { tags: ['Attachments'], summary: 'Delete an attachment', security: bearer, parameters: [idParam(), idParam('attachmentId')], responses: { 204: ok('Deleted') } } },

    '/notifications': { get: { tags: ['Notifications'], summary: 'My notifications', security: bearer, parameters: [{ name: 'unread', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }], responses: { 200: ok('List', obj({ notifications: { type: 'array', items: ref('Notification') }, unreadCount: int })) } } },
    '/notifications/read-all': { post: { tags: ['Notifications'], summary: 'Mark all as read', security: bearer, responses: { 200: ok('Done') } } },
    '/notifications/{id}/read': { patch: { tags: ['Notifications'], summary: 'Mark one as read', security: bearer, parameters: [idParam()], responses: { 200: ok('Done'), 404: errs[404] } } },
    '/notifications/stream': { get: { tags: ['Notifications'], summary: 'Real-time SSE stream', description: 'Open in a browser/EventSource with `?token=<jwt>`. Swagger UI cannot display a live stream; use the live demo at `/demo` instead.', parameters: [{ name: 'token', in: 'query', required: true, schema: str }], responses: { 200: { description: 'text/event-stream' } } } },

    '/ai/task-description': { post: { tags: ['AI'], summary: 'Generate title/description/checklist from a short idea', security: bearer, requestBody: body(obj({ prompt: str }, ['prompt']), { prompt: 'fix login bug on mobile' }), responses: { 200: ok('Generated', obj({ title: str, description: str, checklist: { type: 'array', items: str }, source: { type: 'string', enum: ['ai', 'template'] } })) } } },
  },
};
