const express = require('express');
const { requireApiKey } = require('./middleware/auth');
const { rateLimiter } = require('./middleware/rateLimit');
const { errorHandler } = require('./middleware/errorHandler');
const { requestLogger } = require('./middleware/logger');
const apiRouter = require('./routes/api');

/** Build an Express app bound to a specific database handle (injectable for tests). */
function createApp(db) {
  const app = express();
  app.locals.db = db;

  app.set('trust proxy', 1); // trust Cloudflare / reverse-proxy X-Forwarded-For
  app.use(requestLogger);
  app.use(express.json({ limit: '10mb' })); // /sets/:id/words/bulk carries the full CSV seed (Resources/English.csv is 357KB on disk)

  // A corrupt or locked SQLite file must not report healthy -- `SELECT 1` actually
  // touches the DB rather than just answering from the process being alive (§3.5).
  app.get('/health', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok' });
    } catch (err) {
      req.log.error({ err }, 'health check: database unreachable');
      res.status(503).json({ status: 'error' });
    }
  });

  app.use(rateLimiter);
  app.use(requireApiKey);
  app.use('/api', apiRouter);

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
