'use strict';

class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields || null;
  }
}

// check([[field, isValid, message], ...]) throws one 400 listing every bad field.
function check(rules) {
  const fields = {};
  for (const [field, ok, message] of rules) {
    if (!ok && !fields[field]) fields[field] = message;
  }
  if (Object.keys(fields).length) {
    throw new HttpError(400, 'Please fix the highlighted fields.', fields);
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// Small in-memory sliding-window limiter (resets when the server restarts).
function createLimiter() {
  const hits = new Map();

  function recent(key, windowMs, now) {
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length) hits.set(key, arr);
    else hits.delete(key);
    return arr;
  }

  return {
    // Throws 429 when `key` already has `max` or more hits inside the window.
    assert(key, max, windowMs) {
      const now = Date.now();
      const arr = recent(key, windowMs, now);
      if (arr.length >= max) {
        const minutes = Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 60000));
        throw new HttpError(429, `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
      }
    },
    hit(key, windowMs) {
      const now = Date.now();
      const arr = recent(key, windowMs, now);
      arr.push(now);
      hits.set(key, arr);
    },
    clear(key) {
      hits.delete(key);
    },
    sweep(maxAgeMs = 60 * 60 * 1000) {
      const now = Date.now();
      for (const [key, arr] of hits) {
        if (!arr.length || now - arr[arr.length - 1] > maxAgeMs) hits.delete(key);
      }
    },
  };
}

module.exports = { HttpError, check, str, limiter: createLimiter() };
