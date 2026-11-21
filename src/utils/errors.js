/** Operational error that maps cleanly to an HTTP response. */
class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (m, d) => new AppError(400, m, d);
const unauthorized = (m = 'Authentication required') => new AppError(401, m);
const forbidden = (m = 'You do not have permission to do that') => new AppError(403, m);
const notFound = (m = 'Resource not found') => new AppError(404, m);
const conflict = (m) => new AppError(409, m);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict };
