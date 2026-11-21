const { badRequest } = require('../utils/errors');

/**
 * validate(schema, 'body' | 'query' | 'params')
 * Parsed body/params replace the originals; parsed query is exposed as req.validQuery.
 */
module.exports = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    }));
    return next(badRequest('Validation failed', details));
  }
  if (source === 'query') req.validQuery = result.data;
  else req[source] = result.data;
  next();
};
