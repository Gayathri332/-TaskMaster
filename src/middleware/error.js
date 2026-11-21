const multer = require('multer');
const { AppError } = require('../utils/errors');
const config = require('../config');

const notFoundHandler = (req, res) =>
  res.status(404).json({ error: { message: `Route not found: ${req.method} ${req.originalUrl}` } });

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { message: err.message, details: err.details } });
  }
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File too large (max ${config.maxUploadBytes / 1024 / 1024} MB)`
        : err.message;
    return res.status(400).json({ error: { message } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Malformed JSON body' } });
  }
  console.error(err);
  res.status(500).json({ error: { message: 'Internal server error' } });
};

module.exports = { notFoundHandler, errorHandler };
