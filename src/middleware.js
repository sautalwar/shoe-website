'use strict';

const { randomBytes, timingSafeEqual } = require('node:crypto');
const { COOKIE_NAME, LIMITS, RESET_NOTICE } = require('./shared');

const TOKEN = /^[a-f0-9]{64}$/;

function presentedCookie(req, cookieName) {
  const header = req.headers && req.headers.cookie;
  return typeof header === 'string' && header.split(';').some(part => {
    const separator = part.indexOf('=');
    return separator !== -1 && part.slice(0, separator).trim() === cookieName;
  });
}

function createSessionMiddleware({
  cookieName = COOKIE_NAME, sessionMaxAge = LIMITS.sessionMaxAge,
} = {}) {
  if (typeof cookieName !== 'string' || !cookieName ||
      !Number.isSafeInteger(sessionMaxAge) || sessionMaxAge <= 0) {
    throw new TypeError('A cookie name and positive sessionMaxAge are required.');
  }
  return (req, res, next) => {
    if (!req.session) return next(new Error('Session middleware must run after express-session.'));
    res.locals.notice = res.locals.notice || '';
    const now = Date.now();
    const initialized = req.session.storefrontInitialized === true &&
      typeof req.session.csrfToken === 'string' && req.session.csrfToken.length === 64 &&
      TOKEN.test(req.session.csrfToken) &&
      Number.isSafeInteger(req.session.lastActivityAt) &&
      req.session.lastActivityAt <= now && now - req.session.lastActivityAt < sessionMaxAge;
    if (!initialized) {
      req.session.csrfToken = randomBytes(32).toString('hex');
      req.session.cart = [];
      delete req.session.review;
      delete req.session.receipt;
      req.session.storefrontInitialized = true;
      res.locals.notice = presentedCookie(req, cookieName) ? RESET_NOTICE : '';
    } else if (!Array.isArray(req.session.cart)) {
      req.session.cart = [];
      delete req.session.review;
      res.locals.notice = 'Invalid cart data was reset. Please add your items again.';
    }
    req.session.lastActivityAt = now;
    res.locals.csrfToken = req.session.csrfToken;
    res.locals.cartCount = req.session.cart.reduce((count, line) => {
      const quantity = line && line.quantity;
      return Number.isInteger(quantity) && quantity >= LIMITS.quantityMin &&
        quantity <= LIMITS.quantityMax ? Math.min(LIMITS.cartQuantity, count + quantity) : count;
    }, 0);
    next();
  };
}

function createCsrfMiddleware() {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const submitted = req.body && req.body._csrf;
    const expected = req.session && req.session.csrfToken;
    if (typeof submitted === 'string' && submitted.length === 64 && TOKEN.test(submitted) &&
        typeof expected === 'string' && expected.length === 64 && TOKEN.test(expected) &&
        timingSafeEqual(Buffer.from(submitted), Buffer.from(expected))) {
      return next();
    }
    const message = 'Your session or form expired. Refresh the page and try again.';
    res.status(403);
    if (typeof res.render === 'function') {
      return res.render('error', {
        title: 'Refresh your form', status: 403, message, errors: {},
      }, (error, html) => {
        if (error) return res.type('text').send(message);
        return res.send(html);
      });
    }
    return res.type('text').send(message);
  };
}

module.exports = { createSessionMiddleware, createCsrfMiddleware };
