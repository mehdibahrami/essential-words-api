/** Throwable carrying an HTTP status + machine code. Services throw these; the
 * central handler renders them as JSON. */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = (msg) => new HttpError(400, 'BAD_REQUEST', msg);
const notFound = (msg = 'Not found') => new HttpError(404, 'NOT_FOUND', msg);
const conflict = (msg) => new HttpError(409, 'CONFLICT', msg);

// Wrap async route handlers so thrown/rejected errors reach the error middleware.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  // better-sqlite3 constraint violations -> 409
  if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
    return res.status(409).json({ error: 'CONFLICT', message: err.message });
  }
  console.error('Unhandled error:', err);
  return res.status(500).json({ error: 'SERVER_ERROR', message: 'Internal server error' });
}

module.exports = { HttpError, badRequest, notFound, conflict, asyncHandler, errorHandler };
