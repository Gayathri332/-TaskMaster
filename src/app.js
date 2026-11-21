const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const openapi = require('./openapi');
require('./db'); // initialise schema on startup

const { notFoundHandler, errorHandler } = require('./middleware/error');

const app = express();

app.use(helmet());
// The demo page uses inline <script>/<style>; allow that for this single route only.
app.use('/demo', (_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
  next();
});
app.use(cors());
app.use(express.json({ limit: '100kb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Interactive API docs (Swagger UI) + a tiny live-notifications demo page
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'TaskMaster API', swaggerOptions: { persistAuthorization: true } }));
app.get('/api-docs.json', (_req, res) => res.json(openapi));
app.get('/demo', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'demo.html')));
app.get('/', (_req, res) => res.redirect('/api-docs'));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/teams', require('./routes/teams'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/ai', require('./routes/ai'));

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
