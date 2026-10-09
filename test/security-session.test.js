'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const request = require('supertest');
const { createApp } = require('../src/app');
const { createDatabase } = require('../src/db');
const { createCatalog } = require('../src/catalog');
const { COOKIE_NAME, RESET_NOTICE } = require('../src/shared');

const sessionSecret = 'session-test-only-secret-not-for-deployment';

class ClockStore extends session.Store {
  constructor() {
    super();
    this.sessions = new Map();
    this.now = Date.now();
  }

  get(id, callback) {
    const value = this.sessions.get(id);
    if (value && new Date(value.cookie.expires).getTime() <= this.now) {
      this.sessions.delete(id);
      return callback(null, null);
    }
    callback(null, value ? JSON.parse(JSON.stringify(value)) : null);
  }

  set(id, value, callback = () => {}) {
    this.sessions.set(id, JSON.parse(JSON.stringify(value)));
    callback(null);
  }

  destroy(id, callback = () => {}) {
    this.sessions.delete(id);
    callback(null);
  }

  touch(id, value, callback = () => {}) {
    const previous = this.sessions.get(id);
    if (previous) previous.cookie = JSON.parse(JSON.stringify(value.cookie));
    callback(null);
  }

  stopInterval() { this.sessions.clear(); }
}

function fixture(t, options = {}) {
  const db = createDatabase({ filename: ':memory:' });
  const store = new ClockStore();
  const app = createApp({ db, store, sessionSecret, logger: { error() {} }, ...options });
  t.after(() => {
    store.stopInterval();
    if (db.open) db.close();
  });
  return { app, db, store, product: createCatalog(db).listProducts().products[0] };
}

function hiddenValue(html, name) {
  const field = html.match(new RegExp(`<input\\b[^>]*\\bname=["']${name}["'][^>]*>`, 'i'));
  assert.ok(field, `Expected the ${name} form field`);
  const value = field[0].match(/\bvalue=["']([^"']+)["']/i);
  assert.ok(value);
  return value[1];
}

function csrf(html) { return hiddenValue(html, '_csrf'); }

function sessionCookie(response) {
  const cookies = response.headers['set-cookie'] || [];
  const cookie = cookies.find((value) => value.startsWith(`${COOKIE_NAME}=`));
  assert.ok(cookie, 'Expected a session cookie');
  return cookie;
}

test('session cookies protect tokens with HttpOnly, SameSite and rolling expiry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { app, store, product } = fixture(t, { sessionMaxAge: 30000 });
  const start = Date.now();
  const first = await request(app).get(`/products/${product.id}`).expect(200);
  const cookie = sessionCookie(first);
  assert.match(cookie, /;\s*HttpOnly/i);
  assert.match(cookie, /;\s*SameSite=Lax/i);
  assert.doesNotMatch(cookie, /;\s*Secure/i);
  const expires = new Date(cookie.match(/;\s*Expires=([^;]+)/i)[1]).getTime();
  assert.ok(expires >= start + 28000 && expires <= Date.now() + 31000);
  assert.match(csrf(first.text), /^[a-f0-9]{64}$/);
  t.mock.timers.tick(2000);
  store.now = Date.now();
  const next = await request(app).get(`/products/${product.id}`)
    .set('Cookie', cookie.split(';')[0]).expect(200);
  assert.equal(csrf(next.text), csrf(first.text));
  const renewedExpiry = new Date(sessionCookie(next).match(/;\s*Expires=([^;]+)/i)[1]).getTime();
  assert.ok(renewedExpiry >= expires + 2000, 'An active request must extend idle cookie expiry');
  assert.equal(store.sessions.size, 1);
});

test('production behind one trusted HTTPS proxy uses secure session cookies', async (t) => {
  const { app, product } = fixture(t, { production: true, trustProxy: 1 });
  const response = await request(app).get(`/products/${product.id}`)
    .set('X-Forwarded-Proto', 'https').expect(200);
  assert.match(sessionCookie(response), /;\s*Secure/i);
  assert.match(sessionCookie(response), /;\s*HttpOnly/i);
});

test('all cart and checkout POSTs reject missing, malformed and cross-session CSRF tokens', async (t) => {
  const { app, product } = fixture(t);
  const first = request.agent(app);
  const second = request.agent(app);
  const firstToken = csrf((await first.get(`/products/${product.id}`).expect(200)).text);
  const secondToken = csrf((await second.get(`/products/${product.id}`).expect(200)).text);
  assert.notEqual(firstToken, secondToken);
  for (const route of ['/cart/items', '/cart/items/update', '/cart/items/remove', '/checkout']) {
    for (const token of [undefined, 'short', firstToken.slice(0, -1), 'x'.repeat(64), secondToken, [firstToken, firstToken]]) {
      const response = await first.post(route).type('form').send({
        ...(token === undefined ? {} : { _csrf: token }),
        productId: product.id, size: product.sizes[0], quantity: '1', acknowledgment: 'yes',
      }).expect(403);
      assert.match(response.text, /refresh|retry|try again/i);
    }
  }
  assert.ok(!(await first.get('/cart').expect(200)).text.includes(product.name));
  assert.ok(!(await first.get('/confirmation').expect(200)).text.includes(product.name));
});

test('CSRF middleware protects other state-changing methods while GET and HEAD remain usable', async (t) => {
  const router = express.Router();
  router.get('/probe', (req, res) => res.json({ token: req.session.csrfToken, cart: req.session.cart }));
  router.all('/mutation', (req, res) => {
    req.session.cart.push({ productId: 'probe', size: '8', quantity: 1 });
    res.sendStatus(204);
  });
  const { app } = fixture(t, { router });
  const agent = request.agent(app);
  const initial = await agent.get('/probe').expect(200);
  assert.match(initial.body.token, /^[a-f0-9]{64}$/);
  await agent.head('/probe').expect(200);
  for (const method of ['post', 'put', 'patch', 'delete']) {
    await agent[method]('/mutation').type('form').send({ _csrf: 'wrong' }).expect(403);
  }
  assert.deepEqual((await agent.get('/probe').expect(200)).body.cart, []);
  await agent.post('/mutation').type('form').send({ _csrf: initial.body.token }).expect(204);
  assert.equal((await agent.get('/probe').expect(200)).body.cart.length, 1);
});

test('expired server state resets cart and tokens and makes the old token unusable', async (t) => {
  const { app, store, product } = fixture(t, { sessionMaxAge: 30000 });
  const first = await request(app).get(`/products/${product.id}`).expect(200);
  const oldCookie = sessionCookie(first).split(';')[0];
  const oldToken = csrf(first.text);
  await request(app).post('/cart/items').set('Cookie', oldCookie).type('form').send({
    _csrf: oldToken, productId: product.id, size: product.sizes[0], quantity: '1',
  }).expect(303);
  store.now = Date.now() + 31000;
  const expired = await request(app).get(`/products/${product.id}`).set('Cookie', oldCookie).expect(200);
  assert.ok(expired.text.includes(RESET_NOTICE));
  const newToken = csrf(expired.text);
  assert.notEqual(newToken, oldToken);
  const newCookie = sessionCookie(expired).split(';')[0];
  assert.notEqual(newCookie, oldCookie);
  store.now = Date.now();
  await request(app).post('/cart/items').set('Cookie', newCookie).type('form').send({
    _csrf: oldToken, productId: product.id, size: product.sizes[0], quantity: '1',
  }).expect(403);
  const cart = await request(app).get('/cart').set('Cookie', newCookie).expect(200);
  assert.ok(!cart.text.includes(product.name));
});

test('a stale cookie after store restart and malformed cookies reset safely without leaking tokens', async (t) => {
  const { app, store, product } = fixture(t);
  const first = await request(app).get(`/products/${product.id}`).expect(200);
  assert.ok(!first.text.includes(RESET_NOTICE));
  const cookie = sessionCookie(first).split(';')[0];
  const token = csrf(first.text);
  store.sessions.clear();
  const restarted = await request(app).post('/cart/items').set('Cookie', cookie).type('form').send({
    _csrf: token, productId: product.id, size: product.sizes[0], quantity: '1',
  }).expect(403);
  assert.ok(!restarted.text.includes(token));
  const malformed = await request(app).get(`/products/${product.id}`)
    .set('Cookie', `${COOKIE_NAME}=s%3Amalformed.invalid`).expect(200);
  assert.ok(malformed.text.includes(RESET_NOTICE));
  assert.notEqual(csrf(malformed.text), token);
});

test('separate browser sessions cannot read or mutate one another’s carts', async (t) => {
  const { app, product } = fixture(t);
  const first = request.agent(app);
  const second = request.agent(app);
  const firstToken = csrf((await first.get(`/products/${product.id}`).expect(200)).text);
  const secondToken = csrf((await second.get(`/products/${product.id}`).expect(200)).text);
  await first.post('/cart/items').type('form').send({
    _csrf: firstToken, productId: product.id, size: product.sizes[0], quantity: '2',
  }).expect(303);
  assert.ok((await first.get('/cart').expect(200)).text.includes(product.name));
  assert.ok(!(await second.get('/cart').expect(200)).text.includes(product.name));
  await second.post('/cart/items/remove').type('form').send({
    _csrf: firstToken, productId: product.id, size: product.sizes[0],
  }).expect(403);
  await second.post('/cart/items/remove').type('form').send({
    _csrf: secondToken, productId: product.id, size: product.sizes[0],
  }).expect(400);
  assert.ok((await first.get('/cart').expect(200)).text.includes(product.name));
});

test('a completed demo receipt disappears with idle expiry instead of becoming a public order', async (t) => {
  const { app, store, product } = fixture(t, { sessionMaxAge: 30000 });
  const first = await request(app).get(`/products/${product.id}`).expect(200);
  const cookie = sessionCookie(first).split(';')[0];
  await request(app).post('/cart/items').set('Cookie', cookie).type('form').send({
    _csrf: csrf(first.text), productId: product.id, size: product.sizes[0], quantity: '1',
  }).expect(303);
  const review = await request(app).get('/checkout').set('Cookie', cookie).expect(200);
  await request(app).post('/checkout').set('Cookie', cookie).type('form').send({
    _csrf: csrf(review.text), reviewToken: hiddenValue(review.text, 'reviewToken'), acknowledgment: 'yes',
  }).expect(303);
  const confirmation = await request(app).get('/confirmation').set('Cookie', cookie).expect(200);
  assert.ok(confirmation.text.includes(product.name));
  store.now = Date.now() + 31000;
  const expired = await request(app).get('/confirmation').set('Cookie', cookie).expect(200);
  assert.ok(expired.text.includes(RESET_NOTICE));
  assert.ok(!expired.text.includes(product.name));
  assert.match(expired.text, /expired|no.*confirmation|no.*receipt|not.*available|no.*checkout/i);
});
