require('./helpers'); // sets process.env before config-dependent modules load

const { createApp } = require('../src/app');
const request = require('supertest');

describe('/health', () => {
  test('returns ok when the database answers SELECT 1', async () => {
    const { openDatabase } = require('../src/db');
    const app = createApp(openDatabase(':memory:'));
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('returns 503, not 200, when the database is unreachable', async () => {
    const brokenDb = { prepare: () => { throw new Error('database disk image is malformed'); } };
    const app = createApp(brokenDb);
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error' });
  });

  test('needs no API key either way', async () => {
    const brokenDb = { prepare: () => { throw new Error('locked'); } };
    const app = createApp(brokenDb);
    const res = await request(app).get('/health');
    expect(res.status).toBe(503); // reached the handler at all, i.e. auth wasn't required
  });
});
