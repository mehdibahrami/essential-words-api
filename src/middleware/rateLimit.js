const rateLimit = require('express-rate-limit');
const config = require('../config');

const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimitRpm,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded. Try again in a minute.' });
  },
});

module.exports = { rateLimiter };
