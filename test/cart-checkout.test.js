'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const MemoryStore = require('memorystore')(require('express-session'));
const { createCartService } = require('../src/cart');
const { createDatabase } = require('../src/db');
const { createCatalog } = require('../src/catalog');
const { createApp } = require('../src/app');
const { StoreError, LIMITS, COOKIE_NAME, formatMoney } = require('../src/shared');

const sessionSecret = 'checkout-test-only-secret-not-for-deployment';

// Delayed store I/O exposes competing express-session snapshots, not just helper calls.
class SnapshotStore extends MemoryStore {
  get(id, callback) {
    super.get(id, (error, value) => setTimeout(() => callback(error, value), 5));
  }

  set(id, value, callback) {
    const snapshot = JSON.parse(JSON.stringify(value));
    setTimeout(() => super.set(id, snapshot, callback), 5);
  }
}

function serviceFixture() {
  const products = new Map(Array.from({ length: 22 }, (_, index) => {
    const product = {
      id: `shoe-${index}`, name: `Test shoe ${index}`, category: 'running',
      description: 'Original test data', priceCents: 1001 + index,
      imagePath: `/images/shoe-${index}.svg`, sizes: ['8', '9'],
    };
    return [product.id, product];
  }));
  const catalog = {
    getProduct(id) { return products.get(id) || null; },
    getVariant(id, size) {
      const product = products.get(id);
      return product?.sizes.includes(size) ? { product, size } : null;
    },
  };
  return { products, service: createCartService({ catalog }), session: { cart: [] } };
}

function input(productId = 'shoe-0', size = '8', quantity = '1') {
  return { productId, size, quantity };
}

function rejectsInput(fn, field) {
  assert.throws(fn, (error) => error instanceof StoreError && error.status === 400 &&
    (!field || typeof error.fieldErrors[field] === 'string'));
}

function rejectsReview(fn) {
  assert.throws(fn, (error) => error instanceof StoreError && error.status === 409);
}

function httpFixture(t) {
  const db = createDatabase({ filename: ':memory:' });
  const product = createCatalog(db).listProducts().products[0];
  const store = new SnapshotStore({ checkPeriod: 60000, max: 100 });
  const app = createApp({ db, store, sessionSecret, logger: { error() {} } });
  t.after(() => {
    app.locals.sessionStore.stopInterval();
    if (db.open) db.close();
  });
  return { db, product, agent: request.agent(app), app };
}

function hiddenValue(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = html.match(new RegExp(`<input\\b[^>]*\\bname=["']${escaped}["'][^>]*>`, 'i'));
  assert.ok(tag, `Expected hidden form field ${name}`);
  const value = tag[0].match(/\bvalue=["']([^"']*)["']/i);
  assert.ok(value, `Expected value for ${name}`);
  return value[1];
}

async function addHttp(agent, product, quantity = '1') {
  const page = await agent.get(`/products/${product.id}`).expect(200);
  const csrf = hiddenValue(page.text, '_csrf');
  await agent.post('/cart/items').type('form').send({
    _csrf: csrf, productId: product.id, size: product.sizes[0], quantity,
    priceCents: 1, unitPriceCents: 1, subtotalCents: 1,
  }).expect(303).expect('Location', '/cart');
  return csrf;
}

async function reviewHttp(agent) {
  const page = await agent.get('/checkout').expect(200);
  return { _csrf: hiddenValue(page.text, '_csrf'), reviewToken: hiddenValue(page.text, 'reviewToken') };
}

test('cart merges exact variants, separates sizes, and derives integer-cent totals despite client prices', () => {
  const { service, session } = serviceFixture();
  service.addItem(session, { ...input('shoe-0', '8', '2'), priceCents: 1, unitPriceCents: 1 });
  service.addItem(session, input('shoe-0', '8', '3'));
  const summary = service.addItem(session, input('shoe-0', '9', '1'));
  assert.equal(summary.lineCount, 2);
  assert.equal(summary.totalQuantity, 6);
  assert.equal(summary.subtotalCents, 6006);
  assert.deepEqual(summary.lines.map((line) => [line.size, line.quantity, line.unitPriceCents, line.lineTotalCents]),
    [['8', 5, 1001, 5005], ['9', 1, 1001, 1001]]);
  assert.deepEqual(session.cart, [
    { productId: 'shoe-0', size: '8', quantity: 5 },
    { productId: 'shoe-0', size: '9', quantity: 1 },
  ]);
});

test('quantities and US sizes are strict and invalid updates leave the cart untouched', () => {
  const { service, session } = serviceFixture();
  service.addItem(session, input());
  const original = structuredClone(session.cart);
  for (const quantity of ['0', '11', '-1', '+1', '01', '1.0', '1x', ' 1', '1 ', '1\n', '1\r', '', [], {}, 1.5, NaN]) {
    rejectsInput(() => service.addItem(session, input('shoe-0', '8', quantity)), 'quantity');
    rejectsInput(() => service.updateItem(session, input('shoe-0', '8', quantity)), 'quantity');
    assert.deepEqual(session.cart, original);
  }
  for (const size of ['08', '8.0', 8, ['8'], '13']) {
    rejectsInput(() => service.addItem(session, input('shoe-0', size)), 'size');
    assert.deepEqual(session.cart, original);
  }
  rejectsInput(() => service.addItem(session, input('missing-product')));
  rejectsInput(() => service.addItem(session, input('shoe-0\n')));
  rejectsInput(() => service.updateItem(session, input('shoe-1')));
  rejectsInput(() => service.removeItem(session, { productId: 'shoe-1', size: '8' }));
});

test('merged line quantity cannot overflow and failures do not partially mutate', () => {
  const { service, session } = serviceFixture();
  service.addItem(session, input('shoe-0', '8', '10'));
  const original = structuredClone(session.cart);
  rejectsInput(() => service.addItem(session, input()));
  assert.deepEqual(session.cart, original);
  assert.equal(service.getCart(session).subtotalCents, 10010);
});

test('total-unit and distinct-line bounds are atomic, with the boundary itself accepted', () => {
  const { service, session } = serviceFixture();
  for (let index = 0; index < 10; index++) service.addItem(session, input(`shoe-${index}`, '8', '10'));
  assert.equal(service.getCart(session).totalQuantity, 100);
  let original = structuredClone(session.cart);
  rejectsInput(() => service.addItem(session, input('shoe-10')));
  assert.deepEqual(session.cart, original);
  service.updateItem(session, input('shoe-0', '8', '9'));
  service.addItem(session, input('shoe-10'));
  original = structuredClone(session.cart);
  rejectsInput(() => service.updateItem(session, input('shoe-0', '8', '10')));
  assert.deepEqual(session.cart, original);

  const second = serviceFixture();
  for (let index = 0; index < 20; index++) second.service.addItem(second.session, input(`shoe-${index}`));
  assert.equal(second.service.getCart(second.session).lineCount, 20);
  original = structuredClone(second.session.cart);
  rejectsInput(() => second.service.addItem(second.session, input('shoe-20')));
  assert.deepEqual(second.session.cart, original);
});

test('cart reload reprices server-side and drops unavailable or malformed stored lines visibly', () => {
  const { service, session, products } = serviceFixture();
  service.addItem(session, input('shoe-0', '8', '2'));
  service.addItem(session, input('shoe-1'));
  products.get('shoe-0').priceCents = 1234;
  products.delete('shoe-1');
  session.cart.push({ productId: 'shoe-2', size: '8', quantity: '2junk', priceCents: 1 });
  const summary = service.getCart(session);
  assert.equal(summary.subtotalCents, 2468);
  assert.equal(summary.totalQuantity, 2);
  assert.equal(summary.lineCount, 1);
  assert.ok(summary.notices.length > 0);
  assert.deepEqual(session.cart, [{ productId: 'shoe-0', size: '8', quantity: 2 }]);
});

test('review requires a cart and exact acknowledgment, and successful checkout is a consumed snapshot', () => {
  const { service, session, products } = serviceFixture();
  rejectsReview(() => service.createReview(session));
  service.addItem(session, input('shoe-0', '8', '2'));
  const review = service.createReview(session);
  assert.match(review.token, /^[a-f0-9]{64}$/);
  for (const acknowledgment of [undefined, '', 'true', true, ['yes'], 'YES']) {
    rejectsInput(() => service.completeCheckout(session, { reviewToken: review.token, acknowledgment }));
    assert.equal(service.getCart(session).totalQuantity, 2);
    assert.equal(session.receipt, undefined);
  }
  const receipt = service.completeCheckout(session, { reviewToken: review.token, acknowledgment: 'yes' });
  assert.equal(receipt.subtotalCents, 2002);
  assert.equal(receipt.totalQuantity, 2);
  assert.ok(typeof receipt.reference === 'string' && receipt.reference.length > 0);
  assert.equal(new Date(receipt.completedAt).toISOString(), receipt.completedAt);
  assert.deepEqual(receipt.lines, review.summary.lines);
  assert.deepEqual(session.cart, []);
  assert.equal(session.review, undefined);
  assert.deepEqual(session.receipt, receipt);
  products.get('shoe-0').priceCents = 9999;
  review.summary.lines[0].quantity = 9;
  assert.equal(receipt.lines[0].quantity, 2);
  assert.equal(receipt.lines[0].unitPriceCents, 1001);
  const original = structuredClone(receipt);
  rejectsReview(() => service.completeCheckout(session, { reviewToken: review.token, acknowledgment: 'yes' }));
  assert.deepEqual(session.receipt, original);
});

test('missing, wrong and expired review tokens cannot clear the cart or create receipts', () => {
  const { service, session } = serviceFixture();
  service.addItem(session, input());
  rejectsReview(() => service.completeCheckout(session, { acknowledgment: 'yes' }));
  const review = service.createReview(session);
  rejectsReview(() => service.completeCheckout(session, { reviewToken: 'wrong', acknowledgment: 'yes' }));
  session.review.createdAt = Date.now() - LIMITS.reviewMaxAge - 1;
  rejectsReview(() => service.completeCheckout(session, { reviewToken: review.token, acknowledgment: 'yes' }));
  assert.equal(service.getCart(session).totalQuantity, 1);
  assert.equal(session.receipt, undefined);
});

test('price, size availability and direct quantity changes require a fresh checkout review', () => {
  for (const change of [
    ({ products }) => { products.get('shoe-0').priceCents++; },
    ({ products }) => { products.get('shoe-0').sizes = ['9']; },
    ({ session }) => { session.cart[0].quantity = 2; },
  ]) {
    const fixture = serviceFixture();
    fixture.service.addItem(fixture.session, input());
    const review = fixture.service.createReview(fixture.session);
    change(fixture);
    rejectsReview(() => fixture.service.completeCheckout(fixture.session, {
      reviewToken: review.token, acknowledgment: 'yes',
    }));
    assert.equal(fixture.session.receipt, undefined);
  }
});

test('every successful cart mutation invalidates its prior review', () => {
  for (const mutate of [
    (service, session) => service.addItem(session, input('shoe-1')),
    (service, session) => service.updateItem(session, input('shoe-0', '8', '2')),
    (service, session) => service.removeItem(session, { productId: 'shoe-0', size: '8' }),
  ]) {
    const { service, session } = serviceFixture();
    service.addItem(session, input());
    const review = service.createReview(session);
    mutate(service, session);
    assert.equal(session.review, undefined);
    rejectsReview(() => service.completeCheckout(session, { reviewToken: review.token, acknowledgment: 'yes' }));
  }
});

test('HTTP happy checkout uses server prices, PRG and a session-only demo confirmation', async (t) => {
  const { agent, product, app } = httpFixture(t);
  await addHttp(agent, product, '2');
  const cart = await agent.get('/cart').expect(200);
  assert.ok(cart.text.includes(formatMoney(product.priceCents * 2)));
  const fields = await reviewHttp(agent);
  await agent.post('/checkout').type('form').send({ ...fields, acknowledgment: 'yes', subtotalCents: 1 })
    .expect(303).expect('Location', '/confirmation');
  const confirmation = await agent.get('/confirmation').expect(200);
  assert.match(confirmation.text, /no payment taken; no real order placed/i);
  assert.ok(confirmation.text.includes(formatMoney(product.priceCents * 2)));
  assert.ok(!(await agent.get('/cart').expect(200)).text.includes(`/products/${product.id}`));
  const stranger = await request.agent(app).get('/confirmation').expect(200);
  assert.ok(!stranger.text.includes(product.name));
});

test('HTTP empty checkout redirects to a usable empty cart with explanation', async (t) => {
  const { agent } = httpFixture(t);
  await agent.get('/checkout').expect(303).expect('Location', '/cart');
  const cart = await agent.get('/cart').expect(200);
  assert.match(cart.text, /empty|add.*shoe|add.*item/i);
});

test('HTTP confirmation without a session receipt is explained without inventing an order', async (t) => {
  const { agent, product } = httpFixture(t);
  const page = await agent.get('/confirmation').expect(200);
  assert.match(page.text, /expired|no.*confirmation|no.*receipt|not.*available|no.*checkout/i);
  assert.ok(page.text.includes('/products'));
  assert.ok(!page.text.includes(product.name));
});

test('HTTP missing acknowledgment and review token are non-mutating recoverable failures', async (t) => {
  const { agent, product } = httpFixture(t);
  await addHttp(agent, product);
  const fields = await reviewHttp(agent);
  const missingAck = await agent.post('/checkout').type('form').send(fields).expect(400);
  assert.match(missingAck.text, /acknowledg|confirm|agree/i);
  await agent.post('/checkout').type('form').send({ _csrf: fields._csrf, acknowledgment: 'yes' }).expect(409);
  const cart = await agent.get('/cart').expect(200);
  assert.ok(cart.text.includes(product.name));
  const confirmation = await agent.get('/confirmation').expect(200);
  assert.ok(!confirmation.text.includes(product.name));
});

test('HTTP duplicate concurrent submissions produce exactly one confirmation', async (t) => {
  const { agent, product, app } = httpFixture(t);
  await addHttp(agent, product);
  const page = await agent.get('/checkout').expect(200);
  const cookie = page.headers['set-cookie'].find((value) => value.startsWith(`${COOKIE_NAME}=`)).split(';')[0];
  const fields = {
    _csrf: hiddenValue(page.text, '_csrf'),
    reviewToken: hiddenValue(page.text, 'reviewToken'), acknowledgment: 'yes',
  };
  const responses = await Promise.all([
    request(app).post('/checkout').set('Cookie', cookie).type('form').send(fields),
    request(app).post('/checkout').set('Cookie', cookie).type('form').send(fields),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [303, 409]);
  const before = await agent.get('/confirmation').expect(200);
  await agent.post('/checkout').type('form').send(fields).expect(409);
  assert.equal((await agent.get('/confirmation').expect(200)).text, before.text);
});

test('HTTP simultaneous adds with the same session cookie preserve both variant merges', async (t) => {
  const { app, product } = httpFixture(t);
  const page = await request(app).get(`/products/${product.id}`).expect(200);
  const cookie = page.headers['set-cookie'].find((value) => value.startsWith(`${COOKIE_NAME}=`)).split(';')[0];
  const token = hiddenValue(page.text, '_csrf');
  const responses = await Promise.all(['2', '3'].map((quantity) =>
    request(app).post('/cart/items').set('Cookie', cookie).type('form').send({
      _csrf: token, productId: product.id, size: product.sizes[0], quantity,
    })));
  assert.deepEqual(responses.map((response) => response.status), [303, 303]);
  for (const response of responses) assert.equal(response.headers.location, '/cart');
  const review = await request(app).get('/checkout').set('Cookie', cookie).expect(200);
  assert.ok(review.text.includes(formatMoney(product.priceCents * 5)));
  await request(app).post('/checkout').set('Cookie', cookie).type('form').send({
    _csrf: hiddenValue(review.text, '_csrf'),
    reviewToken: hiddenValue(review.text, 'reviewToken'), acknowledgment: 'yes',
  }).expect(303);
  const confirmation = await request(app).get('/confirmation').set('Cookie', cookie).expect(200);
  assert.ok(confirmation.text.includes(formatMoney(product.priceCents * 5)));
});

test('HTTP price changes invalidate a review and require re-review and acknowledgment', async (t) => {
  const { agent, product, db } = httpFixture(t);
  await addHttp(agent, product);
  const fields = await reviewHttp(agent);
  db.prepare('UPDATE products SET price_cents = ? WHERE id = ?').run(product.priceCents + 137, product.id);
  await agent.post('/checkout').type('form').send({ ...fields, acknowledgment: 'yes' }).expect(409);
  const cart = await agent.get('/cart').expect(200);
  assert.ok(cart.text.includes(formatMoney(product.priceCents + 137)));
  const renewed = await reviewHttp(agent);
  assert.notEqual(renewed.reviewToken, fields.reviewToken);
  await agent.post('/checkout').type('form').send(renewed).expect(400);
  await agent.post('/checkout').type('form').send({ ...renewed, acknowledgment: 'yes' })
    .expect(303).expect('Location', '/confirmation');
});

test('HTTP cart mutation makes a previously reviewed checkout token stale', async (t) => {
  const { agent, product } = httpFixture(t);
  await addHttp(agent, product);
  const fields = await reviewHttp(agent);
  await agent.post('/cart/items/update').type('form').send({
    _csrf: fields._csrf, productId: product.id, size: product.sizes[0], quantity: '2',
  }).expect(303).expect('Location', '/cart');
  await agent.post('/checkout').type('form').send({ ...fields, acknowledgment: 'yes' }).expect(409);
  assert.ok((await agent.get('/cart').expect(200)).text.includes(formatMoney(product.priceCents * 2)));
});

test('HTTP invalid cart fields do not mutate a valid existing cart', async (t) => {
  const { agent, product } = httpFixture(t);
  const csrf = await addHttp(agent, product);
  for (const quantity of ['1x', '01', '0', '11']) {
    const response = await agent.post('/cart/items/update').type('form').send({
      _csrf: csrf, productId: product.id, size: product.sizes[0], quantity,
    }).expect(400);
    assert.match(response.text, /quantity/i);
  }
  const review = await agent.get('/checkout').expect(200);
  assert.ok(review.text.includes(formatMoney(product.priceCents)));
});
