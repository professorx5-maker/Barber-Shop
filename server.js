'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { db, seed } = require('./lib/db');
const auth = require('./lib/auth');
const { routes } = require('./lib/routes');
const { HttpError, limiter } = require('./lib/util');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PARTIALS_DIR = path.join(PUBLIC_DIR, 'partials');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

// ---------- responses ----------

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.COOKIE_SECURE === '1' || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function send(req, res, status, type, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ---------- HTML templating (shop details come from config.js) ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function fmt12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${suffix}`;
}

const isAlwaysOpen = () => Object.values(config.hours).length === 7 && Object.values(config.hours).every((h) => h && h[0] === '00:00' && h[1] === '24:00');

function hoursHtml() {
  if (isAlwaysOpen()) {
    return '<p class="open-always"><strong>Open 24 hours, 365 days a year.</strong><br>Walk in any time, day or night, or book a chair online.</p>';
  }
  const rows = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const h = config.hours[d];
    return `<div><dt>${DAY_NAMES[d]}</dt><dd>${h ? `${fmt12(h[0])} to ${fmt12(h[1])}` : 'Closed'}</dd></div>`;
  });
  return `<dl class="hours">${rows.join('')}</dl>`;
}

function cancelLeadText() {
  const m = config.cancelLeadMinutes;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`;
  return `${m} minutes`;
}

function renderHtml(file) {
  const tokens = {
    name: esc(config.shop.name),
    address: esc(config.shop.address),
    phone: esc(config.shop.phone),
    phoneHref: esc(config.shop.phone.replace(/[^\d+]/g, '')),
    email: esc(config.shop.email),
    // Address and email are optional, so their whole line disappears when empty.
    addressBlock: config.shop.address ? `<p class="address">${esc(config.shop.address)}</p>` : '',
    footerAddress: config.shop.address ? `<p>${esc(config.shop.address)}</p>` : '',
    footerEmail: config.shop.email ? `<p><a href="mailto:${esc(config.shop.email)}">${esc(config.shop.email)}</a></p>` : '',
    visitContact:
      `<p><a href="tel:${esc(config.shop.phone.replace(/[^\d+]/g, ''))}">${esc(config.shop.phone)}</a>` +
      (config.shop.email ? `<br><a href="mailto:${esc(config.shop.email)}">${esc(config.shop.email)}</a>` : '') +
      '</p>',
    hours: hoursHtml(),
    year: String(new Date().getFullYear()),
    cancelLead: cancelLeadText(),
  };
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace(/<!--#(header|footer)-->/g, (_, name) => fs.readFileSync(path.join(PARTIALS_DIR, `${name}.html`), 'utf8'));
  return html.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in tokens ? tokens[key] : whole));
}

// ---------- static files ----------

function resolvePublic(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  if (rel.endsWith('/')) rel += 'index.html';
  else if (!path.extname(rel)) rel += '.html'; // /book -> /book.html

  const segments = rel.split('/').filter(Boolean);
  if (segments.some((s) => s.startsWith('.')) || segments[0] === 'partials') return null;
  const abs = path.join(PUBLIC_DIR, ...segments);
  return abs.startsWith(PUBLIC_DIR + path.sep) ? abs : null;
}

function notFound(req, res) {
  const page = path.join(PUBLIC_DIR, '404.html');
  if (fs.existsSync(page)) return send(req, res, 404, MIME['.html'], renderHtml(page), { 'Cache-Control': 'no-cache' });
  send(req, res, 404, 'text/plain; charset=utf-8', 'Not found');
}

function serveStatic(req, res, url) {
  const abs = resolvePublic(url.pathname);
  const ext = abs ? path.extname(abs).toLowerCase() : '';
  let stat = null;
  if (abs && MIME[ext]) {
    try {
      stat = fs.statSync(abs);
    } catch {
      stat = null;
    }
  }
  if (!stat || !stat.isFile()) return notFound(req, res);

  if (ext === '.html') {
    return send(req, res, 200, MIME[ext], renderHtml(abs), { 'Cache-Control': 'no-cache' });
  }

  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = { 'Content-Type': MIME[ext], 'Cache-Control': 'no-cache', ETag: etag };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs).pipe(res);
}

// ---------- API plumbing ----------

function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

// Browsers always send Origin on cross-site writes; reject when it is not us.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const chunks = [];
    let size = 0;
    let rejected = false;

    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        reject(new HttpError(413, 'That request is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      if (!size) return resolve({});
      if (type !== 'application/json') return reject(new HttpError(415, 'Send JSON.'));
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      } catch {
        reject(new HttpError(400, 'That request was not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  let matched = null;
  let pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method === req.method) {
      matched = { r, m };
      break;
    }
  }
  if (!matched) {
    req.resume();
    return sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? 'Method not allowed.' : 'Not found.' });
  }

  const { r, m } = matched;
  const ctx = {
    req,
    res,
    ip: clientIp(req),
    query: Object.fromEntries(url.searchParams),
    params: {},
    body: {},
    user: auth.userFromRequest(req),
    status: 200,
  };
  r.keys.forEach((key, i) => {
    ctx.params[key] = decodeURIComponent(m[i + 1]);
  });

  if (r.opts.auth) {
    if (!ctx.user) throw new HttpError(401, 'Log in to continue.');
    if (r.opts.auth === 'admin' && ctx.user.role !== 'admin') throw new HttpError(403, 'This page is for shop staff.');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!sameOrigin(req)) throw new HttpError(403, 'Cross-site request blocked.');
    ctx.body = await readJson(req);
  }

  const data = await r.handler(ctx);
  sendJson(res, ctx.status, data);
}

async function handle(req, res) {
  securityHeaders(req, res);
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(req, res, 405, 'text/plain; charset=utf-8', 'Method not allowed', { Allow: 'GET, HEAD' });
  }
  if (url.pathname === '/manifest.webmanifest') return serveManifest(req, res);
  serveStatic(req, res, url);
}

// The app name comes from config.js, so changing the shop name renames the phone app too.
function serveManifest(req, res) {
  const name = config.shop.name;
  const manifest = {
    name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description: `Book a chair at ${name} online.`,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f7f3f6',
    theme_color: '#231a33',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Book a chair', url: '/book.html' },
      { name: 'My bookings', url: '/account.html' },
    ],
  };
  send(req, res, 200, 'application/manifest+json; charset=utf-8', JSON.stringify(manifest), { 'Cache-Control': 'no-cache' });
}

function createServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) {
        return sendJson(res, err.status, { error: err.message, ...(err.fields ? { fields: err.fields } : {}) });
      }
      if (err instanceof URIError) return sendJson(res, 400, { error: 'Bad request.' });
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong on our side. Try again in a moment.' });
    });
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  return server;
}

// ---------- startup ----------

// Creates the owner's admin account. Set ADMIN_EMAIL and ADMIN_PASSWORD to choose
// the login (also resets the password on restart). Otherwise a random password
// is generated on first run and printed once.
async function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';

  if (email && password) {
    if (password.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
    const hash = await auth.hashPassword(password);
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) db.prepare("UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?").run(hash, existing.id);
    else db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Shop owner', ?, ?, 'admin')").run(email, hash);
    return { email, password: null };
  }

  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) return null;

  const generated = { email: 'admin@gloriahairstudio.local', password: crypto.randomBytes(9).toString('base64url') };
  const hash = await auth.hashPassword(generated.password);
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Shop owner', ?, ?, 'admin')").run(generated.email, hash);
  return generated;
}

async function init() {
  seed();
  auth.purgeExpiredSessions();
  return ensureAdmin();
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

async function main() {
  const admin = await init();
  const server = await listen(config.port);

  console.log(`\n${config.shop.name} is running at http://localhost:${server.address().port}`);
  console.log(`Shop times use the ${config.timezone} timezone.`);
  if (admin && admin.password) {
    console.log('\nAdmin login created (shown once, so save it):');
    console.log(`  email:    ${admin.email}`);
    console.log(`  password: ${admin.password}`);
    console.log('  To choose your own, restart with ADMIN_EMAIL and ADMIN_PASSWORD set.');
  } else if (admin) {
    console.log(`\nAdmin login ready for ${admin.email}.`);
  }
  console.log('\nPress Ctrl+C to stop.\n');

  setInterval(() => {
    auth.purgeExpiredSessions();
    limiter.sweep();
  }, 60 * 60 * 1000).unref();

  const stop = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { init, listen };
