'use strict';
const fs = require('fs');
const nodePath = require('path');
const { db, transaction } = require('./db');
const config = require('../config');
const auth = require('./auth');
const S = require('./schedule');
const { HttpError, check, str, limiter } = require('./util');

const routes = [];

// route(method, '/api/path/:id', [{ auth: 'user' | 'admin' }], handler)
// A handler receives { params, query, body, user, ip, req, res, status } and
// returns the JSON to send. Set ctx.status to change the 200 default.
function route(method, path, opts, handler) {
  if (typeof opts === 'function') {
    handler = opts;
    opts = {};
  }
  const keys = [];
  const re = new RegExp(
    '^' +
      path.replace(/:([a-z]+)/gi, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$'
  );
  routes.push({ method, re, keys, opts, handler });
}

// ---------- shaping rows for the client ----------

// A service picture is public/images/services/<name>.<ext>. A real photo
// (jpg, webp or png) wins over the drawing (svg) when both exist.
const IMAGE_DIR = nodePath.join(__dirname, '..', 'public', 'images', 'services');
const IMAGE_EXTS = ['.jpg', '.jpeg', '.webp', '.png', '.svg'];
function serviceImage(name) {
  const base = /^[a-z0-9-]+$/.test(name || '') ? name : 'default';
  for (const ext of IMAGE_EXTS) {
    if (fs.existsSync(nodePath.join(IMAGE_DIR, base + ext))) return `/images/services/${base}${ext}`;
  }
  return '/images/services/default.svg';
}

// Highest price of a range, or null when the service has one fixed price.
const priceMax = (low, high) => (high && high > low ? high : null);

const mapService = (r) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  durationMin: r.duration_min,
  priceCents: r.price_cents,
  priceMaxCents: priceMax(r.price_cents, r.price_max_cents),
  image: serviceImage(r.image),
  active: !!r.active,
});

const mapBarber = (r) => ({
  id: r.id,
  name: r.name,
  specialty: r.specialty,
  bio: r.bio,
  worksDays: r.works_days.split(',').filter(Boolean).map(Number),
});

const mapUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone || '', role: u.role });

const BOOKING_SELECT = `
  SELECT b.*, s.name AS service_name, br.name AS barber_name,
         u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
  FROM bookings b
  JOIN services s ON s.id = b.service_id
  JOIN barbers br ON br.id = b.barber_id
  JOIN users u ON u.id = b.user_id`;

function mapBooking(r, withCustomer = false) {
  const out = {
    id: r.id,
    date: r.date,
    startTime: S.toHHMM(r.start_min),
    endTime: S.toHHMM(r.end_min),
    status: r.status,
    notes: r.notes,
    priceCents: r.price_cents,
    priceMaxCents: priceMax(r.price_cents, r.price_max_cents),
    isPast: S.minutesUntil(r.date, r.end_min) < 0,
    canCancel: r.status === 'booked' && S.minutesUntil(r.date, r.start_min) >= config.cancelLeadMinutes,
    service: { id: r.service_id, name: r.service_name },
    barber: { id: r.barber_id, name: r.barber_name },
    createdAt: r.created_at,
  };
  if (withCustomer) {
    out.customer = { name: r.customer_name, email: r.customer_email, phone: r.customer_phone || '' };
  }
  return out;
}

const activeBarbers = () => db.prepare('SELECT * FROM barbers WHERE active = 1 ORDER BY id').all();

// ---------- auth ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[0-9+()\-\s]{7,20}$/;
const FIFTEEN_MIN = 15 * 60 * 1000;

route('POST', '/api/auth/register', async (ctx) => {
  limiter.assert(`register:${ctx.ip}`, 10, 60 * 60 * 1000);
  limiter.hit(`register:${ctx.ip}`, 60 * 60 * 1000);

  const name = str(ctx.body.name);
  const email = str(ctx.body.email).toLowerCase();
  const phone = str(ctx.body.phone);
  const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';

  check([
    ['name', name.length >= 2 && name.length <= 60, 'Enter your name (2 to 60 characters).'],
    ['email', email.length <= 254 && EMAIL_RE.test(email), 'Enter a valid email address.'],
    ['phone', !phone || PHONE_RE.test(phone), 'Use 7 to 20 digits. Spaces, +, - and brackets are fine.'],
    ['password', password.length >= 8 && password.length <= 128, 'Use at least 8 characters.'],
    ['password', password.toLowerCase() !== email, 'Choose a password that is not your email.'],
  ]);

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'An account with this email already exists. Log in instead.', {
      email: 'This email already has an account.',
    });
  }

  const hash = await auth.hashPassword(password);
  const info = db
    .prepare('INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)')
    .run(name, email, phone || null, hash);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
  auth.startSession(ctx.req, ctx.res, user.id);
  ctx.status = 201;
  return { user: mapUser(user) };
});

route('POST', '/api/auth/login', async (ctx) => {
  const email = str(ctx.body.email).toLowerCase();
  const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
  const ipKey = `login-ip:${ctx.ip}`;
  const acctKey = `login-acct:${email}`;

  // Only failed attempts count, so real customers are never locked out by their own logins.
  limiter.assert(ipKey, 30, FIFTEEN_MIN);
  limiter.assert(acctKey, 8, FIFTEEN_MIN);

  const user = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
  const ok = await auth.verifyPassword(password, user ? user.password_hash : auth.DUMMY_HASH);
  if (!user || !ok) {
    limiter.hit(ipKey, FIFTEEN_MIN);
    limiter.hit(acctKey, FIFTEEN_MIN);
    throw new HttpError(401, 'Email or password is incorrect.');
  }

  limiter.clear(acctKey);
  auth.startSession(ctx.req, ctx.res, user.id);
  return { user: mapUser(user) };
});

route('POST', '/api/auth/logout', (ctx) => {
  auth.endSession(ctx.req, ctx.res);
  return { ok: true };
});

route('GET', '/api/auth/me', (ctx) => ({ user: ctx.user ? mapUser(ctx.user) : null }));

// ---------- public shop data ----------

route('GET', '/api/shop', () => ({
  shop: config.shop,
  timezone: config.timezone,
  hours: config.hours,
  today: S.nowInShop().date,
  bookingWindowDays: config.bookingWindowDays,
  cancelLeadMinutes: config.cancelLeadMinutes,
}));

route('GET', '/api/services', () => ({
  services: db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY sort, id').all().map(mapService),
}));

route('GET', '/api/barbers', () => ({ barbers: activeBarbers().map(mapBarber) }));

route('GET', '/api/availability', (ctx) => {
  const { date } = ctx.query;
  const serviceId = Number(ctx.query.serviceId);
  const barberParam = ctx.query.barberId || 'any';

  check([['date', S.isValidDate(date) && S.inWindow(date), `Pick a date within the next ${config.bookingWindowDays} days.`]]);

  const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(serviceId);
  if (!service) throw new HttpError(400, 'Choose a service first.', { serviceId: 'Choose a service.' });

  let barbers;
  if (barberParam === 'any') barbers = activeBarbers();
  else {
    const one = db.prepare('SELECT * FROM barbers WHERE id = ? AND active = 1').get(Number(barberParam));
    if (!one) throw new HttpError(400, 'That barber is not available.', { barberId: 'Choose a barber.' });
    barbers = [one];
  }

  const slots = new Map();
  for (const b of barbers) {
    for (const start of S.availableStarts(date, b, service.duration_min)) {
      if (!slots.has(start)) slots.set(start, []);
      slots.get(start).push(b.id);
    }
  }

  return {
    date,
    open: !!S.openHours(date),
    slots: [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([m, ids]) => ({ time: S.toHHMM(m), barberIds: ids })),
  };
});

// Feeds the "Open today" board on the home page: the first day with free
// time, and each barber working that day with their first few openings.
route('GET', '/api/next-open', () => {
  const minDuration =
    db.prepare('SELECT MIN(duration_min) AS d FROM services WHERE active = 1').get().d || config.slotMinutes;
  const barbers = activeBarbers();
  const today = S.nowInShop().date;

  for (let i = 0; i < 14; i++) {
    const date = S.addDays(today, i);
    const working = barbers
      .filter((b) => S.openHours(date) && S.barberWorks(b, date))
      .map((b) => {
        const times = S.availableStarts(date, b, minDuration).map(S.toHHMM);
        return { id: b.id, name: b.name, times: times.slice(0, 4), more: Math.max(0, times.length - 4), free: times.length };
      });
    if (working.some((b) => b.free > 0)) {
      return { date, isToday: i === 0, barbers: working };
    }
  }
  return { date: null, isToday: false, barbers: [] };
});

// ---------- bookings ----------

route('POST', '/api/bookings', { auth: 'user' }, (ctx) => {
  const b = ctx.body;
  const serviceId = Number(b.serviceId);
  const date = b.date;
  const time = typeof b.time === 'string' ? b.time : '';
  const notes = str(b.notes);
  const barberParam = b.barberId === undefined || b.barberId === null ? 'any' : String(b.barberId);

  check([
    ['date', S.isValidDate(date) && S.inWindow(date), `Pick a date within the next ${config.bookingWindowDays} days.`],
    ['time', /^([01]\d|2[0-3]):[0-5]\d$/.test(time), 'Pick a time.'],
    ['notes', notes.length <= 200, 'Keep notes under 200 characters.'],
  ]);

  const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(serviceId);
  if (!service) throw new HttpError(400, 'Choose a service.', { serviceId: 'Choose a service.' });

  const start = S.toMin(time);
  const end = start + service.duration_min;
  const today = S.nowInShop().date;

  const upcoming = db
    .prepare("SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status = 'booked' AND date >= ?")
    .get(ctx.user.id, today).n;
  if (upcoming >= config.maxActiveBookings) {
    throw new HttpError(409, `You already have ${upcoming} upcoming bookings. Cancel one or wait until after your next visit.`);
  }

  const clash = db
    .prepare("SELECT 1 FROM bookings WHERE user_id = ? AND date = ? AND status = 'booked' AND start_min < ? AND end_min > ?")
    .get(ctx.user.id, date, end, start);
  if (clash) throw new HttpError(409, 'You already have a booking that overlaps this time.');

  let candidates;
  if (barberParam === 'any') candidates = activeBarbers();
  else {
    const one = db.prepare('SELECT * FROM barbers WHERE id = ? AND active = 1').get(Number(barberParam));
    if (!one) throw new HttpError(400, 'That barber is not available.', { barberId: 'Choose a barber.' });
    candidates = [one];
  }

  const bookingId = transaction(() => {
    // For "any barber", prefer whoever has the lightest day so work is shared out.
    const load = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE barber_id = ? AND date = ? AND status = 'booked'");
    const ordered = candidates
      .map((c) => ({ c, n: load.get(c.id, date).n }))
      .sort((x, y) => x.n - y.n)
      .map((x) => x.c);

    const chosen = ordered.find((c) => S.availableStarts(date, c, service.duration_min).includes(start));
    if (!chosen) throw new HttpError(409, 'Sorry, that time is no longer available. Pick another time.');

    const info = db
      .prepare(
        'INSERT INTO bookings (user_id, barber_id, service_id, date, start_min, end_min, notes, price_cents, price_max_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(ctx.user.id, chosen.id, service.id, date, start, end, notes, service.price_cents, service.price_max_cents ?? null);
    return Number(info.lastInsertRowid);
  });

  ctx.status = 201;
  return { booking: mapBooking(db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(bookingId)) };
});

route('GET', '/api/bookings/mine', { auth: 'user' }, (ctx) => {
  const rows = db
    .prepare(`${BOOKING_SELECT} WHERE b.user_id = ? ORDER BY b.date DESC, b.start_min DESC LIMIT 200`)
    .all(ctx.user.id)
    .map((r) => mapBooking(r));
  const upcoming = rows.filter((r) => r.status === 'booked' && !r.isPast).reverse();
  const history = rows.filter((r) => !(r.status === 'booked' && !r.isPast));
  return { upcoming, history };
});

route('POST', '/api/bookings/:id/cancel', { auth: 'user' }, (ctx) => {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?').get(Number(ctx.params.id), ctx.user.id);
  if (!row) throw new HttpError(404, 'Booking not found.');
  if (row.status !== 'booked') throw new HttpError(409, 'This booking is already closed.');
  if (S.minutesUntil(row.date, row.start_min) < config.cancelLeadMinutes) {
    throw new HttpError(
      409,
      `Bookings can be cancelled up to ${config.cancelLeadMinutes} minutes before the start. Call the shop on ${config.shop.phone} to change this one.`
    );
  }
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(row.id);
  return { booking: mapBooking(db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(row.id)) };
});

// ---------- admin ----------

route('GET', '/api/admin/summary', { auth: 'admin' }, (ctx) => {
  const today = S.nowInShop().date;
  const date = ctx.query.date || today;
  check([['date', S.isValidDate(date), 'Use a date like 2026-11-04.']]);

  const rows = db
    .prepare(`${BOOKING_SELECT} WHERE b.date = ? ORDER BY b.start_min, b.id`)
    .all(date)
    .map((r) => mapBooking(r, true));
  const counted = rows.filter((r) => r.status === 'booked' || r.status === 'completed');

  return {
    date,
    today,
    bookings: rows,
    stats: {
      dayCount: counted.length,
      expectedCents: counted.reduce((sum, r) => sum + r.priceCents, 0),
      earnedCents: rows.filter((r) => r.status === 'completed').reduce((sum, r) => sum + r.priceCents, 0),
      upcomingCount: db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'booked' AND date >= ?").get(today).n,
      customers: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'").get().n,
    },
  };
});

route('PATCH', '/api/admin/bookings/:id', { auth: 'admin' }, (ctx) => {
  const status = str(ctx.body.status);
  check([['status', ['booked', 'completed', 'cancelled', 'no_show'].includes(status), 'Unknown status.']]);

  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(ctx.params.id));
  if (!row) throw new HttpError(404, 'Booking not found.');

  if (status === 'booked' && row.status !== 'booked') {
    const clash = db
      .prepare(
        "SELECT 1 FROM bookings WHERE barber_id = ? AND date = ? AND id != ? AND status IN ('booked','completed') AND start_min < ? AND end_min > ?"
      )
      .get(row.barber_id, row.date, row.id, row.end_min, row.start_min);
    if (clash) throw new HttpError(409, 'Another booking now holds that time, so this one cannot be restored.');
  }

  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, row.id);
  return { booking: mapBooking(db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(row.id), true) };
});

route('GET', '/api/admin/services', { auth: 'admin' }, () => ({
  services: db.prepare('SELECT * FROM services ORDER BY sort, id').all().map(mapService),
}));

function checkRange(low, high) {
  if (high !== null && high !== undefined && high <= low) {
    throw new HttpError(400, 'Please fix the highlighted fields.', { priceMaxCents: 'The highest price must be more than the lowest price.' });
  }
}

function parseServiceFields(body, partial) {
  const out = {};
  const rules = [];

  if (!partial || body.name !== undefined) {
    out.name = str(body.name);
    rules.push(['name', out.name.length >= 2 && out.name.length <= 60, 'Enter a name (2 to 60 characters).']);
  }
  if (!partial || body.description !== undefined) {
    out.description = str(body.description);
    rules.push(['description', out.description.length <= 140, 'Keep the description under 140 characters.']);
  }
  if (!partial || body.durationMin !== undefined) {
    out.durationMin = Number(body.durationMin);
    rules.push([
      'durationMin',
      Number.isInteger(out.durationMin) && out.durationMin >= config.slotMinutes && out.durationMin <= 240 && out.durationMin % config.slotMinutes === 0,
      `Use a multiple of ${config.slotMinutes} minutes, up to 240.`,
    ]);
  }
  if (!partial || body.priceCents !== undefined) {
    out.priceCents = Number(body.priceCents);
    rules.push(['priceCents', Number.isInteger(out.priceCents) && out.priceCents >= 0 && out.priceCents <= 100000000, 'Enter a price between 0 and 1,000,000.']);
  }
  // Optional top of a price range. null or an empty value clears it.
  if (body.priceMaxCents !== undefined) {
    const empty = body.priceMaxCents === null || body.priceMaxCents === '';
    out.priceMaxCents = empty ? null : Number(body.priceMaxCents);
    rules.push([
      'priceMaxCents',
      empty || (Number.isInteger(out.priceMaxCents) && out.priceMaxCents > 0 && out.priceMaxCents <= 100000000),
      'Enter the highest price, or leave it empty.',
    ]);
  }
  if (body.active !== undefined) {
    out.active = body.active ? 1 : 0;
  }
  check(rules);
  return out;
}

route('POST', '/api/admin/services', { auth: 'admin' }, (ctx) => {
  const f = parseServiceFields(ctx.body, false);
  checkRange(f.priceCents, f.priceMaxCents);
  const next = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM services').get().n;
  const info = db
    .prepare('INSERT INTO services (name, description, duration_min, price_cents, price_max_cents, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(f.name, f.description, f.durationMin, f.priceCents, f.priceMaxCents ?? null, f.active === undefined ? 1 : f.active, next);
  ctx.status = 201;
  return { service: mapService(db.prepare('SELECT * FROM services WHERE id = ?').get(Number(info.lastInsertRowid))) };
});

route('PATCH', '/api/admin/services/:id', { auth: 'admin' }, (ctx) => {
  const row = db.prepare('SELECT * FROM services WHERE id = ?').get(Number(ctx.params.id));
  if (!row) throw new HttpError(404, 'Service not found.');
  const f = parseServiceFields(ctx.body, true);
  const priceCents = f.priceCents ?? row.price_cents;
  const priceMaxCents = f.priceMaxCents !== undefined ? f.priceMaxCents : row.price_max_cents;
  checkRange(priceCents, priceMaxCents);
  db.prepare(
    'UPDATE services SET name = ?, description = ?, duration_min = ?, price_cents = ?, price_max_cents = ?, active = ? WHERE id = ?'
  ).run(
    f.name ?? row.name,
    f.description ?? row.description,
    f.durationMin ?? row.duration_min,
    priceCents,
    priceMaxCents ?? null,
    f.active ?? row.active,
    row.id
  );
  return { service: mapService(db.prepare('SELECT * FROM services WHERE id = ?').get(row.id)) };
});

module.exports = { routes };
