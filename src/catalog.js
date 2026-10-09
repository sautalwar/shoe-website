'use strict';

const { LIMITS, CATEGORIES, US_SIZES, SORTS, StoreError } = require('./shared');

const PRODUCT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SORT_SQL = Object.freeze({
  featured: 'p.rowid ASC',
  'price-asc': 'p.price_cents ASC, p.name COLLATE NOCASE ASC, p.id ASC',
  'price-desc': 'p.price_cents DESC, p.name COLLATE NOCASE ASC, p.id ASC',
  name: 'p.name COLLATE NOCASE ASC, p.id ASC',
});
const COLUMNS = 'p.id, p.name, p.category, p.description, p.price_cents AS priceCents, p.image_path AS imagePath';

function validId(id) {
  return typeof id === 'string' && id.length <= 64 && id.trim() === id && PRODUCT_ID.test(id);
}

function invalidFilter(field, message) {
  throw new StoreError('INVALID_FILTER', message, 400, { [field]: message });
}

function normalizeFilters(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    invalidFilter('filters', 'Catalog filters must be an object.');
  }
  for (const field of Object.keys(input)) {
    if (!['q', 'category', 'size', 'sort'].includes(field)) {
      invalidFilter('filters', 'An unknown catalog filter was supplied.');
    }
  }
  const filters = { q: '', category: '', size: '', sort: 'featured' };
  for (const field of Object.keys(filters)) {
    if (!Object.hasOwn(input, field)) continue;
    if (typeof input[field] !== 'string') {
      invalidFilter(field, `The ${field} filter must be a single text value.`);
    }
    filters[field] = input[field];
  }
  if (filters.q.length > LIMITS.searchLength) {
    invalidFilter('q', `Search must be ${LIMITS.searchLength} characters or fewer.`);
  }
  filters.q = filters.q.trim();
  if (filters.category && !CATEGORIES.includes(filters.category)) {
    invalidFilter('category', 'Choose a listed shoe category.');
  }
  if (filters.size && !US_SIZES.includes(filters.size)) {
    invalidFilter('size', 'Choose a listed US shoe size.');
  }
  if (!SORTS.includes(filters.sort)) {
    invalidFilter('sort', 'Choose a listed sort order.');
  }
  return filters;
}

function createCatalog(db) {
  const sizesForProduct = db.prepare('SELECT size FROM product_sizes WHERE product_id = ? ORDER BY CAST(size AS INTEGER)');
  const productById = db.prepare(`SELECT ${COLUMNS} FROM products p WHERE p.id = ?`);
  const hydrate = (row) => row ? {
    ...row,
    sizes: sizesForProduct.all(row.id).map(({ size }) => size),
  } : null;

  function listProducts(input = {}) {
    const filters = normalizeFilters(input);
    const clauses = [];
    const values = [];
    if (filters.q) {
      const literal = filters.q.replace(/[\\%_]/g, '\\$&');
      clauses.push("(p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')");
      values.push(`%${literal}%`, `%${literal}%`);
    }
    if (filters.category) {
      clauses.push('p.category = ?');
      values.push(filters.category);
    }
    if (filters.size) {
      clauses.push('EXISTS (SELECT 1 FROM product_sizes s WHERE s.product_id = p.id AND s.size = ?)');
      values.push(filters.size);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT ${COLUMNS} FROM products p ${where} ORDER BY ${SORT_SQL[filters.sort]}`).all(...values);
    return { products: rows.map(hydrate), filters };
  }

  function getProduct(id) {
    return validId(id) ? hydrate(productById.get(id)) : null;
  }

  function getVariant(productId, size) {
    if (typeof size !== 'string' || !US_SIZES.includes(size)) return null;
    const product = getProduct(productId);
    return product && product.sizes.includes(size) ? { product, size } : null;
  }

  return { listProducts, getProduct, getVariant };
}

module.exports = { createCatalog };
