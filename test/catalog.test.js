'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const MemoryStore = require('memorystore')(require('express-session'));
const { createDatabase, seedDatabase } = require('../src/db');
const { createCatalog } = require('../src/catalog');
const { createApp } = require('../src/app');
const { StoreError } = require('../src/shared');

const sessionSecret = 'catalog-test-only-secret-not-for-deployment';

function database(t) {
  const db = createDatabase({ filename: ':memory:' });
  t.after(() => { if (db.open) db.close(); });
  return db;
}

function storefront(t, db) {
  const store = new MemoryStore({ checkPeriod: 60000, max: 100 });
  const app = createApp({ db, store, sessionSecret, logger: { error() {} } });
  t.after(() => app.locals.sessionStore.stopInterval());
  return app;
}

function fixtureDirectory() {
  const directory = path.join(__dirname, '..', '.test-data', `catalog-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

test('a missing database creates parents and retains its seeded catalog when reopened', (t) => {
  const directory = fixtureDirectory();
  const filename = path.join(directory, 'nested', 'catalog.sqlite');
  let db;
  t.after(() => {
    if (db?.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  db = createDatabase({ filename });
  const before = createCatalog(db).listProducts().products;
  assert.ok(before.length > 0);
  assert.ok(fs.existsSync(filename));
  db.close();
  db = createDatabase({ filename });
  assert.deepEqual(createCatalog(db).listProducts().products, before);
});

test('seeding repeatedly does not duplicate products or their available sizes', (t) => {
  const db = database(t);
  const catalog = createCatalog(db);
  const before = catalog.listProducts().products;
  seedDatabase(db);
  seedDatabase(db);
  assert.deepEqual(catalog.listProducts().products, before);
  assert.equal(new Set(before.map((product) => product.id)).size, before.length);
  for (const product of before) {
    assert.ok(product.sizes.length > 0);
    assert.equal(new Set(product.sizes).size, product.sizes.length);
    assert.ok(Number.isSafeInteger(product.priceCents) && product.priceCents >= 0);
    assert.deepEqual(catalog.getProduct(product.id), product);
    assert.equal(catalog.getVariant(product.id, product.sizes[0]).product.id, product.id);
  }
});

test('a corrupt database fails without replacing the original file', (t) => {
  const directory = fixtureDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'corrupt.sqlite');
  const contents = Buffer.from('This is deliberately not a SQLite database.');
  fs.writeFileSync(filename, contents);
  assert.throws(() => createDatabase({ filename }));
  assert.deepEqual(fs.readFileSync(filename), contents);
});

test('catalog combines search, category and size and sorts integer-cent prices', (t) => {
  const catalog = createCatalog(database(t));
  const all = catalog.listProducts().products;
  const chosen = all[0];
  const result = catalog.listProducts({
    q: chosen.name, category: chosen.category, size: chosen.sizes[0], sort: 'price-desc',
  });
  assert.ok(result.products.some((product) => product.id === chosen.id));
  assert.deepEqual(result.filters, {
    q: chosen.name, category: chosen.category, size: chosen.sizes[0], sort: 'price-desc',
  });
  assert.ok(result.products.every((product) =>
    product.category === chosen.category && product.sizes.includes(chosen.sizes[0]) &&
    `${product.name} ${product.description}`.toLowerCase().includes(chosen.name.toLowerCase())));
  for (const sort of ['price-asc', 'price-desc']) {
    const prices = catalog.listProducts({ sort }).products.map((product) => product.priceCents);
    assert.deepEqual(prices, [...prices].sort((a, b) => sort === 'price-asc' ? a - b : b - a));
  }
});

test('LIKE metacharacters are searched literally, and SQL input cannot broaden results', (t) => {
  const db = database(t);
  const catalog = createCatalog(db);
  const chosen = catalog.listProducts().products[0];
  db.prepare('UPDATE products SET name = ?, description = ? WHERE id = ?')
    .run('Literal 50% _shoe\\test', 'A distinct catalog search marker', chosen.id);
  for (const q of ['%', '_', '\\', '50% _shoe\\test']) {
    assert.deepEqual(catalog.listProducts({ q }).products.map((product) => product.id), [chosen.id]);
  }
  assert.deepEqual(catalog.listProducts({ q: "' OR 1=1 --" }).products, []);
  assert.ok(catalog.listProducts({ q: 'distinct catalog search marker' }).products
    .some((product) => product.id === chosen.id));
});

test('malformed and unknown filters fail with actionable input errors', (t) => {
  const catalog = createCatalog(database(t));
  for (const input of [
    { q: ['shoe'] }, { q: {} }, { q: 'a'.repeat(101) },
    { category: ['running'] }, { category: 'unknown' },
    { size: '08' }, { size: ['8'] }, { size: '8.0' },
    { sort: 'price_cents DESC; DROP TABLE products' }, { sort: {} },
  ]) {
    assert.throws(() => catalog.listProducts(input), (error) =>
      error instanceof StoreError && error.status === 400);
  }
  assert.doesNotThrow(() => catalog.listProducts({ q: 'a'.repeat(100) }));
  assert.ok(catalog.listProducts().products.length > 0);
});

test('product and variant lookups reject malformed IDs and inexact sizes', (t) => {
  const catalog = createCatalog(database(t));
  const product = catalog.listProducts().products[0];
  for (const id of [undefined, null, [], {}, 1, '1 OR 1=1', '../shoe', 'A-Shoe', 'x'.repeat(65), 'absent-product']) {
    assert.equal(catalog.getProduct(id), null);
  }
  for (const size of [Number(product.sizes[0]), `${product.sizes[0]}.0`, [product.sizes[0]], '13']) {
    assert.equal(catalog.getVariant(product.id, size), null);
  }
  assert.equal(catalog.getVariant('absent-product', product.sizes[0]), null);
});

test('HTTP rejects duplicate/invalid filters and missing products with client errors', async (t) => {
  const app = storefront(t, database(t));
  for (const url of ['/products?q=a&q=b', '/products?category=unknown', '/products?size=08', '/products?sort=unknown']) {
    await request(app).get(url).expect(400);
  }
  await request(app).get('/products/absent-product').expect(404);
  await request(app).get('/products/UPPERCASE').expect(404);
});

test('search and stored product content are escaped rather than interpreted as HTML', async (t) => {
  const db = database(t);
  const catalog = createCatalog(db);
  const chosen = catalog.listProducts().products[0];
  const payload = '<script>alert("catalog")</script>';
  db.prepare('UPDATE products SET name = ?, description = ? WHERE id = ?')
    .run(payload, '<img src=x onerror=alert("description")>', chosen.id);
  const app = storefront(t, db);
  for (const url of [`/products?q=${encodeURIComponent(payload)}`, `/products/${chosen.id}`]) {
    const response = await request(app).get(url).expect(200);
    assert.ok(response.text.includes('&lt;script&gt;'));
    assert.ok(!response.text.includes(payload));
    assert.ok(!response.text.includes('<img src=x onerror='));
  }
});
