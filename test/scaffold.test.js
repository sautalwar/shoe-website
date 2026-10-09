'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const request = require('supertest');
const { createApp } = require('../src/app');
const { readConfig } = require('../src/config');
const { formatMoney } = require('../src/shared');

const sessionSecret = 'scaffold-test-only-secret-not-for-deployment';

test('runtime config rejects absent secret and malformed ports', () => {
  assert.throws(() => readConfig({}), /SESSION_SECRET/);
  assert.throws(() => readConfig({ SESSION_SECRET: sessionSecret, PORT: '3000junk' }), /PORT/);
  assert.throws(() => readConfig({ SESSION_SECRET: sessionSecret, TRUST_PROXY: 'true' }), /TRUST_PROXY/);
  assert.equal(readConfig({ SESSION_SECRET: sessionSecret }).port, 3000);
});

test('factory enforces secret and injectable readiness without leaking database errors', async (t) => {
  assert.throws(() => createApp(), /SESSION_SECRET/);
  const db = new Database(':memory:');
  const app = createApp({ db, sessionSecret });
  t.after(() => {
    if (db.open) db.close();
    app.locals.sessionStore.stopInterval();
  });
  const ready = await request(app).get('/health').expect(200);
  assert.deepEqual(ready.body, { status: 'ok' });
  assert.equal(ready.headers['x-powered-by'], undefined);
  assert.equal(ready.headers['cache-control'], 'no-store');
  db.close();
  const unavailable = await request(app).get('/health').expect(503);
  assert.deepEqual(unavailable.body, { status: 'unavailable' });
});

test('money formatter rejects invalid integer-cent totals', () => {
  assert.equal(formatMoney(12345), '$123.45');
  for (const value of [-1, 1.5, NaN, '100', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => formatMoney(value), /integer cents/);
  }
});
