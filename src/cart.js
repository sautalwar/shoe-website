'use strict';

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { LIMITS, US_SIZES, StoreError } = require('./shared');

const PRODUCT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOKEN = /^[a-f0-9]{64}$/;

function inputError(field, message) {
  return new StoreError('INVALID_CART_INPUT', message, 400, { [field]: message });
}

function validateVariant(productId, size) {
  if (typeof productId !== 'string' || productId.length > 64 ||
      productId.trim() !== productId || !PRODUCT_ID.test(productId)) {
    throw inputError('productId', 'Choose a valid product.');
  }
  if (typeof size !== 'string' || !US_SIZES.includes(size)) {
    throw inputError('size', 'Choose an available US size.');
  }
}

function parseQuantity(quantity) {
  const value = typeof quantity === 'string' && quantity.length <= 2 &&
    quantity.trim() === quantity && /^(?:[1-9]|10)$/.test(quantity)
    ? Number(quantity) : quantity;
  if (!Number.isInteger(value) || value < LIMITS.quantityMin || value > LIMITS.quantityMax) {
    throw inputError('quantity', 'Quantity must be a whole number from 1 to 10.');
  }
  return value;
}

function requireSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new TypeError('A session object is required.');
  }
}

function sameVariant(line, productId, size) {
  return line.productId === productId && line.size === size;
}

function fingerprint(summary) {
  const variants = summary.lines.map(({ productId, size, quantity, unitPriceCents }) =>
    [productId, size, quantity, unitPriceCents]);
  variants.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(variants)).digest('hex');
}

function reviewError() {
  return new StoreError('REVIEW_REQUIRED',
    'Your checkout review expired or the cart changed. Review your cart again and acknowledge the demo notice.',
    409);
}

function createCartService({ catalog }) {
  if (!catalog || typeof catalog.getVariant !== 'function') {
    throw new TypeError('A catalog with getVariant is required.');
  }

  function availableVariant(productId, size) {
    const variant = catalog.getVariant(productId, size);
    if (!variant || !variant.product || variant.product.id !== productId || variant.size !== size ||
        !Array.isArray(variant.product.sizes) || !variant.product.sizes.includes(size)) {
      return null;
    }
    if (!Number.isSafeInteger(variant.product.priceCents) || variant.product.priceCents < 0) {
      throw new Error('Catalog prices must be non-negative safe integer cents.');
    }
    return variant;
  }

  function summarize(descriptors, notices = []) {
    const lines = descriptors.map(({ productId, size, quantity }) => {
      const variant = availableVariant(productId, size);
      if (!variant) throw inputError('size', 'This product and size are no longer available.');
      const { product } = variant;
      const lineTotalCents = product.priceCents * quantity;
      if (!Number.isSafeInteger(lineTotalCents)) throw new Error('Cart total exceeds safe integer cents.');
      return {
        productId, size, quantity, name: product.name, imagePath: product.imagePath,
        unitPriceCents: product.priceCents, lineTotalCents,
      };
    });
    const subtotalCents = lines.reduce((total, line) => total + line.lineTotalCents, 0);
    if (!Number.isSafeInteger(subtotalCents)) throw new Error('Cart total exceeds safe integer cents.');
    return {
      lines, subtotalCents,
      totalQuantity: lines.reduce((total, line) => total + line.quantity, 0),
      lineCount: lines.length, notices: [...notices],
    };
  }

  // Build a candidate first; validation failures must never partially edit session state.
  function inspect(session) {
    requireSession(session);
    const descriptors = [];
    const notices = [];
    let totalQuantity = 0;
    const original = Array.isArray(session.cart) ? session.cart : [];
    if (session.cart !== undefined && !Array.isArray(session.cart)) {
      notices.push('Invalid cart data was removed. Please add your items again.');
    }
    for (const line of original) {
      let quantity;
      try {
        if (!line || typeof line !== 'object' || Array.isArray(line)) throw inputError('cart', 'Invalid line.');
        validateVariant(line.productId, line.size);
        quantity = parseQuantity(line.quantity);
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
        notices.push('An invalid cart item was removed. Please add it again.');
        continue;
      }
      if (!availableVariant(line.productId, line.size)) {
        notices.push('An item or US size is no longer available and was removed from your cart.');
        continue;
      }
      if (descriptors.some(item => sameVariant(item, line.productId, line.size)) ||
          descriptors.length >= LIMITS.cartLines || totalQuantity + quantity > LIMITS.cartQuantity) {
        notices.push('An item exceeding the cart limits was removed.');
        continue;
      }
      descriptors.push({ productId: line.productId, size: line.size, quantity });
      totalQuantity += quantity;
    }
    return { descriptors, summary: summarize(descriptors, notices) };
  }

  function commit(session, descriptors) {
    session.cart = descriptors.map(line => ({ ...line }));
    delete session.review;
  }

  function checkBounds(descriptors) {
    if (descriptors.length > LIMITS.cartLines) {
      throw inputError('productId', `Your cart can contain at most ${LIMITS.cartLines} different product and size combinations.`);
    }
    if (descriptors.reduce((total, line) => total + line.quantity, 0) > LIMITS.cartQuantity) {
      throw inputError('quantity', `Your cart can contain at most ${LIMITS.cartQuantity} units.`);
    }
  }

  function getCart(session) {
    const { descriptors, summary } = inspect(session);
    if (JSON.stringify(session.cart) !== JSON.stringify(descriptors)) {
      commit(session, descriptors);
    }
    return summary;
  }

  function mutate(session, input, action) {
    const { productId, size, quantity: rawQuantity } = input || {};
    validateVariant(productId, size);
    const quantity = action === 'remove' ? null : parseQuantity(rawQuantity);
    const { descriptors, summary: previous } = inspect(session);
    const index = descriptors.findIndex(line => sameVariant(line, productId, size));
    if (action !== 'add' && index === -1) {
      throw inputError('productId', 'That product and US size are not in your cart.');
    }
    if (action !== 'remove' && !availableVariant(productId, size)) {
      throw inputError('size', 'This product and US size are not available.');
    }
    if (action === 'remove') {
      descriptors.splice(index, 1);
    } else if (index === -1) {
      descriptors.push({ productId, size, quantity });
    } else {
      descriptors[index].quantity = parseQuantity(
        action === 'add' ? descriptors[index].quantity + quantity : quantity);
    }
    checkBounds(descriptors);
    const summary = summarize(descriptors, previous.notices);
    commit(session, descriptors);
    return summary;
  }

  function createReview(session) {
    const { descriptors, summary } = inspect(session);
    if (!summary.lineCount) {
      throw new StoreError('EMPTY_CART', 'Add an available item to your cart before reviewing checkout.', 409);
    }
    const token = randomBytes(32).toString('hex');
    const review = { token, fingerprint: fingerprint(summary), createdAt: Date.now() };
    session.cart = descriptors.map(line => ({ ...line }));
    session.review = review;
    return { token, summary };
  }

  function completeCheckout(session, { reviewToken, acknowledgment } = {}) {
    requireSession(session);
    if (acknowledgment !== 'yes') {
      throw new StoreError('ACKNOWLEDGMENT_REQUIRED',
        'Acknowledge that no payment is taken and no real order is placed.', 400,
        { acknowledgment: 'Please acknowledge the demo notice.' });
    }
    const review = session.review;
    const now = Date.now();
    if (!review || typeof reviewToken !== 'string' || reviewToken.length !== 64 || !TOKEN.test(reviewToken) ||
        typeof review.token !== 'string' || review.token.length !== 64 || !TOKEN.test(review.token) ||
        !timingSafeEqual(Buffer.from(reviewToken), Buffer.from(review.token)) ||
        !Number.isSafeInteger(review.createdAt) || review.createdAt > now ||
        now - review.createdAt >= LIMITS.reviewMaxAge) {
      throw reviewError();
    }
    const { summary } = inspect(session);
    if (!summary.lineCount || summary.notices.length || fingerprint(summary) !== review.fingerprint) {
      throw reviewError();
    }
    const receipt = {
      reference: `DEMO-${randomBytes(12).toString('hex').toUpperCase()}`,
      completedAt: new Date(now).toISOString(),
      lines: summary.lines.map(line => ({ ...line })),
      subtotalCents: summary.subtotalCents,
      totalQuantity: summary.totalQuantity,
    };
    delete session.review;
    session.cart = [];
    session.receipt = receipt;
    return { ...receipt, lines: receipt.lines.map(line => ({ ...line })) };
  }

  return {
    getCart,
    addItem: (session, input) => mutate(session, input, 'add'),
    updateItem: (session, input) => mutate(session, input, 'update'),
    removeItem: (session, input) => mutate(session, input, 'remove'),
    createReview,
    completeCheckout,
  };
}

module.exports = { createCartService };
