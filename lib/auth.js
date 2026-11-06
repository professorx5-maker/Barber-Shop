'use strict';
const crypto = require('crypto');
const { db } = require('./db');
const config = require('../config');

const COOKIE = 'cc_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => {
      if (err) return reject(err);
      resolve(['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$'));
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return resolve(false);
    const [, N, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    crypto.scrypt(password, salt, expected.length, { N: +N, r: +r, p: +p }, (err, key) => {
      if (err) return resolve(false);
      resolve(crypto.timingSafeEqual(key, expected));
    });
  });
}

// Checked when the email is unknown so a login takes the same time either way.
const DUMMY_HASH = (() => {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(crypto.randomBytes(8), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
})();

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isSecure(req) {
  return process.env.COOKIE_SECURE === '1' || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https');
}

function cookieHeader(req, value, maxAgeSeconds) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${isSecure(req) ? '; Secure' : ''}`;
}

function startSession(req, res, userId) {
  const old = parseCookies(req.headers.cookie)[COOKIE];
  if (old) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(old));

  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const maxAge = config.sessionDays * 86400;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now + maxAge * 1000, now);
  res.setHeader('Set-Cookie', cookieHeader(req, token, maxAge));
}

function endSession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
}

function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  return (
    db
      .prepare(
        'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'
      )
      .get(sha256(token), Date.now()) || null
  );
}

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

module.exports = {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
  startSession,
  endSession,
  userFromRequest,
  purgeExpiredSessions,
};
