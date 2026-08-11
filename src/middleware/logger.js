const pinoHttp = require('pino-http');
const logger = require('../logger');

// One line per request (method, url, status, responseTime, a generated request id)
// via pino-http's own defaults. Deliberately does not log bodies -- word content and
// the API key must never land in a log line.
const requestLogger = pinoHttp({ logger });

module.exports = { requestLogger };
