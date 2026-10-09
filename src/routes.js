'use strict';

const express = require('express');
const { createCatalog } = require('./catalog');
const { createCartService } = require('./cart');
const { createCsrfMiddleware } = require('./middleware');
const { StoreError, CATEGORIES, US_SIZES, SORTS, LIMITS } = require('./shared');

function createRouter({ db = null } = {}) {
  const router = express.Router();
  let catalog;
  let cartService;

  router.get('/', (req, res) => res.redirect('/products'));
  router.use((req, res, next) => {
    if (!db) throw new StoreError('STORE_UNAVAILABLE', 'The demo catalog is unavailable. Please try again later.', 503);
    if (!catalog) {
      catalog = createCatalog(db);
      cartService = createCartService({ catalog });
    }
    const cart = cartService.getCart(req.session);
    res.locals.cartCount = cart.totalQuantity;
    if (req.session.flash) {
      res.locals.notice = [res.locals.notice, req.session.flash].filter(Boolean).join(' ');
      delete req.session.flash;
    }
    if (cart.notices.length) {
      res.locals.notice = [res.locals.notice, ...cart.notices].filter(Boolean).join(' ');
    }
    next();
  });
  router.use(createCsrfMiddleware());

  router.get('/products', (req, res) => {
    try {
      res.render('products', { title: 'The collection', ...catalog.listProducts(req.query) });
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      const filters = {
        q: typeof req.query.q === 'string' ? req.query.q.slice(0, LIMITS.searchLength) : '',
        category: CATEGORIES.includes(req.query.category) ? req.query.category : '',
        size: US_SIZES.includes(req.query.size) ? req.query.size : '',
        sort: SORTS.includes(req.query.sort) ? req.query.sort : 'featured',
      };
      res.status(error.status).render('products', {
        title: 'Check your filters', products: [], filters, errors: error.fieldErrors,
        notice: [res.locals.notice, error.message].filter(Boolean).join(' '),
      });
    }
  });

  router.get('/products/:id', (req, res) => {
    const product = catalog.getProduct(req.params.id);
    if (!product) throw new StoreError('PRODUCT_NOT_FOUND', 'That sample shoe was not found. Explore the collection for another pair.', 404);
    res.render('product', {
      title: product.name, product,
      form: { productId: product.id, size: '', quantity: '1' },
    });
  });

  function renderCart(req, res, status = 200, errors = {}) {
    const cart = cartService.getCart(req.session);
    res.locals.cartCount = cart.totalQuantity;
    res.status(status).render('cart', { title: 'Your bag', cart, errors });
  }
  router.get('/cart', (req, res) => renderCart(req, res));

  for (const [path, method, message] of [
    ['/cart/items', 'addItem', 'Your sample pair was added to your bag.'],
    ['/cart/items/update', 'updateItem', 'Your bag was updated.'],
    ['/cart/items/remove', 'removeItem', 'Your sample pair was removed from your bag.'],
  ]) {
    router.post(path, (req, res) => {
      try {
        const summary = cartService[method](req.session, req.body);
        req.session.flash = [res.locals.notice, message, ...summary.notices].filter(Boolean).join(' ');
        return res.redirect(303, '/cart');
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
        res.locals.notice = [res.locals.notice, error.message].filter(Boolean).join(' ');
        const product = method === 'addItem' ? catalog.getProduct(req.body?.productId) : null;
        if (product) {
          return res.status(error.status).render('product', {
            title: 'Check your selection', product, errors: error.fieldErrors,
            form: {
              productId: product.id,
              size: typeof req.body.size === 'string' ? req.body.size : '',
              quantity: typeof req.body.quantity === 'string' ? req.body.quantity : '',
            },
          });
        }
        return renderCart(req, res, error.status, error.fieldErrors);
      }
    });
  }

  router.get('/checkout', (req, res) => {
    try {
      const { token, summary } = cartService.createReview(req.session);
      res.locals.cartCount = summary.totalQuantity;
      res.render('checkout', {
        title: 'Review your demo', cart: summary, reviewToken: token,
        form: { acknowledgment: '' },
      });
    } catch (error) {
      if (!(error instanceof StoreError) || error.code !== 'EMPTY_CART') throw error;
      req.session.flash = [res.locals.notice, error.message].filter(Boolean).join(' ');
      res.redirect(303, '/cart');
    }
  });

  router.post('/checkout', (req, res) => {
    try {
      cartService.completeCheckout(req.session, req.body);
      res.locals.cartCount = 0;
      res.redirect(303, '/confirmation');
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      const cart = cartService.getCart(req.session);
      res.locals.cartCount = cart.totalQuantity;
      res.status(error.status).render('checkout', {
        title: 'Check your demo review', cart,
        reviewToken: typeof req.body?.reviewToken === 'string' ? req.body.reviewToken : '',
        form: { acknowledgment: req.body?.acknowledgment === 'yes' ? 'yes' : '' },
        errors: {
          ...error.fieldErrors,
          ...(error.status === 409 ? { reviewToken: error.message } : {}),
        },
        notice: [res.locals.notice, error.message].filter(Boolean).join(' '),
      });
    }
  });

  router.get('/confirmation', (req, res) => res.render('confirmation', {
    title: 'Demo confirmation', receipt: req.session.receipt || null,
  }));
  return router;
}

module.exports = { createRouter };
