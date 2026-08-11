const { z } = require('zod');
const { badRequest } = require('./errorHandler');

function formatZodError(error) {
  return error.issues
    .map((i) => `${i.path.length ? i.path.join('.') : '(body)'}: ${i.message}`)
    .join('; ');
}

/**
 * Validate req.body/query/params against zod schemas before a route handler runs.
 * A schema whitelists its shape: unknown keys are rejected by any `.strict()` schema
 * passed in here, which is what closes an unvalidated `req.body` field from reaching
 * a service (see CLAUDE.md H2 / the 2026-08-11 tech-debt refactor plan §3.1).
 */
function validate({ body, query, params } = {}) {
  return (req, _res, next) => {
    try {
      if (body) req.body = body.parse(req.body);
      if (query) req.query = query.parse(req.query);
      if (params) req.params = params.parse(req.params);
      next();
    } catch (err) {
      if (err instanceof z.ZodError) return next(badRequest(formatZodError(err)));
      next(err);
    }
  };
}

module.exports = { validate };
