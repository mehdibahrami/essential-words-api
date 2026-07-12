// Must set env before requiring config-dependent modules.
process.env.API_KEY = process.env.API_KEY || 'test-api-key-000';
process.env.APP_TIMEZONE = process.env.APP_TIMEZONE || 'Europe/Amsterdam';
process.env.RATE_LIMIT_RPM = process.env.RATE_LIMIT_RPM || '100000';

const request = require('supertest');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

const API_KEY = process.env.API_KEY;

function makeApp() {
  const db = openDatabase(':memory:');
  const app = createApp(db);
  return { app, db };
}

// supertest agent that always sends the API key.
function client(app) {
  const agent = request(app);
  const withKey = (method, url) => agent[method](url).set('x-api-key', API_KEY);
  return {
    raw: agent,
    get: (u) => withKey('get', u),
    post: (u) => withKey('post', u),
    put: (u) => withKey('put', u),
    del: (u) => withKey('delete', u),
  };
}

module.exports = { makeApp, client, request, API_KEY };
