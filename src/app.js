const express = require('express');
const { requireApiKey } = require('./middleware/auth');
const { rateLimiter } = require('./middleware/rateLimit');
const { errorHandler } = require('./middleware/errorHandler');
const apiRouter = require('./routes/api');

/** Build an Express app bound to a specific database handle (injectable for tests). */
function createApp(db) {
  const app = express();
  app.locals.db = db;

  app.set('trust proxy', 1); // trust Cloudflare / reverse-proxy X-Forwarded-For
  app.use(express.json({ limit: '10mb' })); // /sync/import can be large

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use(rateLimiter);
  app.use(requireApiKey);
  app.use('/api', apiRouter);

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
