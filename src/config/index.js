const path = require('path');

const config = {
  port: Number(process.env.PORT) || 3100,
  apiKey: process.env.API_KEY || '',
  rateLimitRpm: Number(process.env.RATE_LIMIT_RPM) || 120,
  timezone: process.env.APP_TIMEZONE || 'Europe/Amsterdam',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  dbPath:
    process.env.DB_PATH ||
    path.join(__dirname, '..', '..', 'data', 'essential-words.sqlite'),
};

module.exports = config;
