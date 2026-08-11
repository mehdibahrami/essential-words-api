const pino = require('pino');

// Behind a Cloudflare tunnel on a Pi, a 500 was previously invisible: the only
// server-side logging was `console.error('Unhandled error:', err)` in the error
// handler, no request log, no timing, no request id (§3.5). Level is quiet by
// default in tests so `npm test` output stays readable.
const logger = pino({ level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info') });

module.exports = logger;
