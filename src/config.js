'use strict';

const path = require('node:path');

function readConfig(env = process.env) {
  const sessionSecret = env.SESSION_SECRET;
  if (typeof sessionSecret !== 'string' || sessionSecret.trim().length < 32) {
    throw new Error('SESSION_SECRET must be set to a random secret of at least 32 characters.');
  }
  const portValue = env.PORT || '3000';
  if (!/^\d+$/.test(portValue) || Number(portValue) < 1 || Number(portValue) > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }
  if (env.TRUST_PROXY && !['0', '1'].includes(env.TRUST_PROXY)) {
    throw new Error('TRUST_PROXY must be 0 or 1.');
  }
  return {
    sessionSecret,
    port: Number(portValue),
    dbPath: path.resolve(env.DB_PATH || path.join('.data', 'shoeshop.sqlite')),
    production: env.NODE_ENV === 'production',
    trustProxy: env.TRUST_PROXY === '1' ? 1 : false,
  };
}

module.exports = { readConfig };
