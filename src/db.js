'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { products } = require('./seed-data');

function readOwner(filename) {
  let text;
  try {
    if (!fs.lstatSync(filename).isFile()) {
      throw new Error('Demo database ownership marker must be a regular file.');
    }
    text = fs.readFileSync(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const owner = JSON.parse(text);
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw new Error('Invalid demo database ownership marker; investigate before retrying.');
  }
  return { ...owner, text };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function checkReset(filename) {
  const owner = readOwner(`${filename}.reset-lock`);
  if (owner && owner.pid !== process.pid && isAlive(owner.pid)) {
    throw new Error('Demo database reset in progress; start the app after reset finishes.');
  }
}

function claimDatabase(filename) {
  checkReset(filename);
  const lockPath = `${filename}.lock`;
  const marker = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const owner = readOwner(lockPath);
  if (owner) {
    if (isAlive(owner.pid)) {
      throw new Error('Demo database is already open. Stop its owning app before continuing.');
    }
    fs.unlinkSync(lockPath);
  }
  fs.writeFileSync(lockPath, marker, { flag: 'wx', mode: 0o600 });
  const release = () => {
    const current = readOwner(lockPath);
    if (current && current.text === marker) fs.unlinkSync(lockPath);
  };
  try {
    // Recheck after claiming so a concurrent reset cannot pass the startup window.
    checkReset(filename);
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

function seedDatabase(db) {
  const insertProduct = db.prepare(`
    INSERT INTO products (id, name, category, description, price_cents, image_path)
    VALUES (@id, @name, @category, @description, @priceCents, @imagePath)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertSize = db.prepare(`
    INSERT INTO product_sizes (product_id, size) VALUES (?, ?)
    ON CONFLICT(product_id, size) DO NOTHING
  `);
  db.transaction(() => {
    for (const product of products) {
      const inserted = insertProduct.run(product);
      // Existing products (including intentionally changed availability) are preserved.
      if (inserted.changes) {
        for (const size of product.sizes) insertSize.run(product.id, size);
      }
    }
  })();
}

function createDatabase({ filename }) {
  if (typeof filename !== 'string' || !filename.trim() || filename.includes('\0')) {
    throw new TypeError('A configured database filename is required.');
  }
  let release = () => {};
  if (filename !== ':memory:') {
    filename = path.resolve(filename);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    filename = path.join(fs.realpathSync(path.dirname(filename)), path.basename(filename));
    if (fs.existsSync(filename) && !fs.lstatSync(filename).isFile()) {
      throw new Error('The configured demo database must be a regular file, not a link or directory.');
    }
    release = claimDatabase(filename);
  }
  let db;
  try {
    db = new Database(filename);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY NOT NULL CHECK (
          length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^a-z0-9-]*'
          AND id NOT LIKE '-%' AND id NOT LIKE '%-' AND id NOT LIKE '%--%'
        ),
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        category TEXT NOT NULL CHECK (category IN ('running', 'casual', 'training')),
        description TEXT NOT NULL,
        price_cents INTEGER NOT NULL CHECK (
          typeof(price_cents) = 'integer' AND price_cents BETWEEN 0 AND 9007199254740991
        ),
        image_path TEXT NOT NULL CHECK (image_path = '/images/' || id || '.svg')
      );
      CREATE TABLE IF NOT EXISTS product_sizes (
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        size TEXT NOT NULL CHECK (size IN ('6', '7', '8', '9', '10', '11', '12')),
        PRIMARY KEY (product_id, size)
      );
    `);
    seedDatabase(db);
    const nativeClose = db.close.bind(db);
    db.close = () => {
      try {
        return nativeClose();
      } finally {
        release();
      }
    };
    return db;
  } catch (error) {
    try {
      if (db && db.open) db.close();
    } finally {
      release();
    }
    throw error;
  }
}

module.exports = { createDatabase, seedDatabase };
