'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const cookie = require('cookie');
const signature = require('cookie-signature');
const { COOKIE_NAME, LIMITS } = require('./shared');

function createSessionLock({ store, sessionSecret }) {
  const context = new AsyncLocalStorage();
  const locks = new Map();
  let queued = 0;
  const maxQueued = LIMITS.maxSessions;
  const maxPerSession = 32;
  const queueTimeout = 15000;

  function sessionId(req) {
    const value = cookie.parse(req.headers.cookie || '')[COOKIE_NAME];
    if (typeof value !== 'string' || !value.startsWith('s:') || value.length > 256) return null;
    const id = signature.unsign(value.slice(2), sessionSecret);
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
  }

  // A disconnected response may still have an asynchronous snapshot write in flight.
  // Track store callbacks as well as response completion before handing off the lock.
  const trackedStore = new Proxy(store, {
    get(target, property) {
      const method = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      if (!['get', 'set', 'touch', 'destroy'].includes(property)) return method.bind(target);
      return (...args) => {
        const state = context.getStore();
        if (!state) return method.apply(target, args);
        state.pending++;
        const callback = args.pop();
        let completed = false;
        function done(...values) {
          if (completed) return;
          completed = true;
          try {
            callback?.(...values);
          } finally {
            state.pending--;
            state.release();
          }
        }
        try {
          return method.apply(target, [...args, done]);
        } catch (error) {
          if (!completed) {
            completed = true;
            state.pending--;
            state.release();
          }
          throw error;
        }
      };
    },
  });

  function middleware(req, res, next) {
    const id = sessionId(req);
    if (!id) return next();
    let lock = locks.get(id);
    if (!lock) {
      if (locks.size >= LIMITS.maxSessions) return busy();
      lock = { queue: [] };
      locks.set(id, lock);
      return enter();
    }
    if (queued >= maxQueued || lock.queue.length >= maxPerSession) return busy();
    const entry = { enter, response: res, timer: null, cancel: null };
    queued++;
    lock.queue.push(entry);
    function remove() {
      const index = lock.queue.indexOf(entry);
      if (index === -1) return;
      lock.queue.splice(index, 1);
      queued--;
      clearTimeout(entry.timer);
      entry.response.removeListener('close', entry.cancel);
    }
    entry.cancel = remove;
    res.once('close', entry.cancel);
    entry.timer = setTimeout(() => { remove(); busy(); }, queueTimeout);
    entry.timer.unref();

    function busy() {
      if (!res.destroyed) res.status(503).type('text')
        .send('Your demo session is busy. Please wait and retry.');
    }

    function enter() {
      if (res.destroyed) return handoff();
      let released = false;
      const state = {
        pending: 0, ended: false,
        release() {
          if (released || !state.ended || state.pending) return;
          released = true;
          handoff();
        },
      };
      res.once('finish', () => { state.ended = true; state.release(); });
      res.once('close', () => {
        // Do not allow a disconnected request to initiate a later session save.
        req.session = null;
        state.ended = true;
        state.release();
      });
      context.run(state, next);
    }

    function handoff() {
      const entry = lock.queue.shift();
      if (!entry) {
        locks.delete(id);
        return;
      }
      queued--;
      clearTimeout(entry.timer);
      entry.response.removeListener('close', entry.cancel);
      entry.enter();
    }
  }

  return { middleware, store: trackedStore };
}

module.exports = { createSessionLock };
