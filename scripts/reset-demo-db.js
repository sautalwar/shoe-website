'use strict';

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readConfig } = require('../src/config');
const { createDatabase } = require('../src/db');

function ownerOf(filename) {
  try {
    if (!fs.lstatSync(filename).isFile()) throw new Error('Ownership marker must be a regular file.');
    const text = fs.readFileSync(filename, 'utf8');
    const owner = JSON.parse(text);
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid ownership marker.');
    return { ...owner, text };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function resetDemoDatabase() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !args.includes('--confirm-demo-reset') || !args.includes('--app-stopped')) {
    throw new Error('Stop the app, then run: npm run db:reset -- --confirm-demo-reset --app-stopped');
  }
  const config = readConfig();
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const filename = path.join(fs.realpathSync(path.dirname(config.dbPath)), path.basename(config.dbPath));
  const resetLock = `${filename}.reset-lock`;
  const existing = ownerOf(resetLock);
  if (existing) {
    if (alive(existing.pid)) throw new Error('A demo database reset is already running.');
    fs.unlinkSync(resetLock);
  }
  const marker = JSON.stringify({ pid: process.pid, token: randomUUID() });
  fs.writeFileSync(resetLock, marker, { flag: 'wx', mode: 0o600 });
  try {
    const appLock = `${filename}.lock`;
    const owner = ownerOf(appLock);
    if (owner && alive(owner.pid)) {
      throw new Error('Demo database is open. Stop the owning app before resetting.');
    }
    const targets = [filename, `${filename}-wal`, `${filename}-shm`, `${filename}-journal`];
    for (const target of targets) {
      try {
        if (!fs.lstatSync(target).isFile()) {
          throw new Error('Reset refused: a configured database target is not a regular file.');
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (owner) fs.unlinkSync(appLock);
    for (const target of targets) {
      try {
        fs.unlinkSync(target);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const db = createDatabase({ filename });
    db.close();
    console.log('Demo database reset to the original sample catalog. No orders or customer data exist.');
  } finally {
    const current = ownerOf(resetLock);
    if (current && current.text === marker) fs.unlinkSync(resetLock);
  }
}

if (require.main === module) {
  try {
    resetDemoDatabase();
  } catch (error) {
    console.error(`Reset refused or failed: ${error.message}`);
    process.exitCode = 1;
  }
}
