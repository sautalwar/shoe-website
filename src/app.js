'use strict';

const path = require('node:path');
const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const helmet = require('helmet');
const { createRouter } = require('./routes');
const { createSessionMiddleware, createCsrfMiddleware } = require('./middleware');
const { createSessionLock } = require('./session-lock');
const {
  LIMITS, CATEGORIES, US_SIZES, SORTS, COOKIE_NAME,
  DEMO_NOTICE, STORAGE_NOTICE, formatMoney, StoreError,
} = require('./shared');

function createApp({
  db = null,
  store,
  sessionSecret,
  production = false,
  trustProxy = false,
  sessionMaxAge = LIMITS.sessionMaxAge,
  router,
  logger = console,
} = {}) {
  if (typeof sessionSecret !== 'string' || sessionSecret.trim().length < 32) {
    throw new Error('SESSION_SECRET must be set to a random secret of at least 32 characters.');
  }
  if (!Number.isSafeInteger(sessionMaxAge) || sessionMaxAge <= 0) {
    throw new Error('sessionMaxAge must be a positive integer in milliseconds.');
  }
  if (![false, 1].includes(trustProxy)) {
    throw new Error('trustProxy must be false or 1.');
  }
  const app = express();
  const sessionStore = store || new MemoryStore({
    checkPeriod: 60 * 1000,
    max: LIMITS.maxSessions,
  });
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.locals = Object.assign(app.locals, {
    siteName: 'ShoeShop', currency: 'USD', sizeSystem: 'US',
    categories: CATEGORIES, sizes: US_SIZES, sorts: SORTS, limits: LIMITS,
    demoNotice: DEMO_NOTICE, storageNotice: STORAGE_NOTICE, formatMoney,
  });
  app.locals.db = db;
  app.locals.sessionStore = sessionStore;
  const sessionLock = createSessionLock({ store: sessionStore, sessionSecret });
  app.use(helmet({
    strictTransportSecurity: production ? undefined : false,
    contentSecurityPolicy: {
      directives: { 'upgrade-insecure-requests': production ? [] : null },
    },
  }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!db || db.prepare('SELECT 1 AS ready').get().ready !== 1) throw new Error('Unavailable');
      res.status(200).json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    Object.assign(res.locals, {
      title: 'ShoeShop', csrfToken: '', notice: '', errors: {},
      cartCount: 0, currentPath: req.path,
    });
    next();
  });
  app.use(sessionLock.middleware);
  app.use(express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 20 }));
  app.use(session({
    name: COOKIE_NAME,
    secret: sessionSecret,
    store: sessionLock.store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true, sameSite: 'lax', secure: production, maxAge: sessionMaxAge,
    },
  }));
  app.use((req, res, next) => {
    if (res.destroyed) {
      req.session = null;
      return;
    }
    next();
  });
  app.use(createSessionMiddleware({ cookieName: COOKIE_NAME, sessionMaxAge }));
  if (router) app.use(createCsrfMiddleware());
  app.use(router || createRouter({ db }));
  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Page not found', status: 404, message: 'Page not found. Return to the collection.',
    });
  });
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 503
      ? err.status : 500;
    logger.error({ code: status === 500 ? 'REQUEST_FAILED' : 'REQUEST_REJECTED', status });
    const message = err instanceof StoreError ? err.message : status === 500
      ? 'Something went wrong. Please try again.'
      : 'The request could not be processed. Refresh the page and try again.';
    res.status(status).render('error', {
      title: 'Please try again', status, message,
      errors: err instanceof StoreError ? err.fieldErrors : {},
    }, (renderError, html) => {
      if (renderError) {
        logger.error({ code: 'ERROR_PAGE_FAILED', status: 500 });
        return res.status(500).type('text').send('Something went wrong. Please try again.');
      }
      res.send(html);
    });
  });
  return app;
}

module.exports = { createApp };
