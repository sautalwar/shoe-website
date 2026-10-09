'use strict';

const LIMITS = Object.freeze({
  quantityMin: 1,
  quantityMax: 10,
  cartLines: 20,
  cartQuantity: 100,
  searchLength: 100,
  sessionMaxAge: 30 * 60 * 1000,
  reviewMaxAge: 10 * 60 * 1000,
  maxSessions: 1000,
});

const CATEGORIES = Object.freeze(['running', 'casual', 'training']);
const US_SIZES = Object.freeze(['6', '7', '8', '9', '10', '11', '12']);
const SORTS = Object.freeze(['featured', 'price-asc', 'price-desc', 'name']);
const COOKIE_NAME = 'shoeshop.sid';
const DEMO_NOTICE = 'Demo store — no payment is taken and no real order is placed.';
const RESET_NOTICE = 'Your demo session expired or the store restarted. Your cart and demo confirmation were reset.';
const STORAGE_NOTICE = 'Demo carts and confirmations expire after 30 minutes of inactivity and reset when the store restarts.';

function formatMoney(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new TypeError('Money must be non-negative integer cents.');
  }
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

class StoreError extends Error {
  constructor(code, message, status = 400, fieldErrors = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

module.exports = {
  LIMITS, CATEGORIES, US_SIZES, SORTS, COOKIE_NAME,
  DEMO_NOTICE, RESET_NOTICE, STORAGE_NOTICE, formatMoney, StoreError,
};
