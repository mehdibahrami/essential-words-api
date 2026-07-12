const { timingSafeEqual, createHmac, randomBytes } = require('crypto');
const config = require('../config');

// Random per-process key so HMACs of unequal-length inputs still compare in
// constant time without leaking length.
const HMAC_SECRET = randomBytes(32);

function hmac(value) {
  return createHmac('sha256', HMAC_SECRET).update(value).digest();
}

function requireApiKey(req, res, next) {
  const provided = req.headers['x-api-key'] || '';
  const expected = config.apiKey || '';

  if (!expected) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'API key not configured' });
  }

  const match = timingSafeEqual(hmac(provided), hmac(expected));
  if (!match) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or missing API key' });
  }

  next();
}

module.exports = { requireApiKey };
