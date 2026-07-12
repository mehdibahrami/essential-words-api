require('dotenv').config();

const config = require('./src/config');

if (!config.apiKey) {
  console.error('FATAL: API_KEY environment variable is not set. Refusing to start.');
  process.exit(1);
}

const { getDb } = require('./src/db');
const { createApp } = require('./src/app');

const app = createApp(getDb());

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Essential Words API running on port ${config.port}`);
  });
}

module.exports = app;
