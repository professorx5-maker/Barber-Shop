'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A throwaway database and a known admin login, set before the app loads.
const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'cc-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.ADMIN_EMAIL = 'owner@example.com';
process.env.ADMIN_PASSWORD = 'owner-pass-123';
process.env.SHOP_TZ = process.env.SHOP_TZ || 'UTC';

const { init, listen } = require('../server');

let server;
let base;

before(async () => {
  await init();
  server = await listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function call(method, url, { body, cookie, headers } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const sid = (res.headers.getSetCookie() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('cc_session='));
  return { status: res.status, json, text, headers: res.headers, cookie: sid };
}

async function register(name, email) {
  const r = await call('POST', '/api/auth/register', { body: { name, email, password: 'a-good-password' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.cookie;
}

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const addDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

// Finds a future day with a slot that two or more barbers can take, plus the
// slot before it, so overlap behaviour can be tested at any time of day.
async function findDay() {
  const shop = (await call('GET', '/api/shop')).json;
  for (let i = 2; i < 14; i++) {
    const date = addDays(shop.today, i);
    const { json } = await call('GET', `/api/availability?date=${date}&serviceId=1&barberId=any`);
    const slots = json.slots;
    const idx = slots.findIndex((s, k) => k > 0 && s.barberIds.length >= 2 && slots[k - 1].barberIds.length >= 1 && toMin(s.time) - toMin(slots[k - 1].time) === 30);
    if (idx > 0) return { date, slot: slots[idx], prev: slots[idx - 1] };
  }
  throw new Error('No suitable day found in the next two weeks');
}

test('public shop data loads', async () => {
  const services = await call('GET', '/api/services');
  assert.equal(services.status, 200);
  assert.equal(services.json.services.length, 10);
  const barbers = await call('GET', '/api/barbers');
  assert.equal(barbers.json.barbers.length, 4);
  assert.deepEqual(barbers.json.barbers.map((b) => b.name), ['Ali Abid', 'Fizi', 'Hamza', 'Zaman']);
  const shop = await call('GET', '/api/shop');
  assert.match(shop.json.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(shop.json.shop.name, 'Gloria Hair Studio');
  assert.equal(shop.json.shop.currency, 'PKR');
  assert.equal(shop.json.timezone, 'UTC'); // the test run sets SHOP_TZ=UTC
  assert.ok(Object.values(shop.json.hours).every((h) => h[0] === '00:00' && h[1] === '24:00'), 'open 24 hours, every day');

  // Prices are rupees x100; some services are a range and each has a picture.
  const byName = Object.fromEntries(services.json.services.map((s) => [s.name, s]));
  assert.equal(byName['Simple cutting'].priceCents, 10000);
  assert.equal(byName['Simple cutting'].priceMaxCents, null);
  assert.equal(byName['Face massage'].priceCents, 20000);
  assert.equal(byName['Face massage'].priceMaxCents, 100000);
  assert.equal(byName['Facial'].priceMaxCents, 600000);
  for (const svc of services.json.services) {
    assert.match(svc.image, /^\/images\/services\/[a-z-]+\.(svg|jpg|jpeg|png|webp)$/);
    const img = await fetch(base + svc.image);
    assert.equal(img.status, 200, svc.image);
    await img.arrayBuffer();
  }
  const next = await call('GET', '/api/next-open');
  assert.equal(next.status, 200);
  assert.ok(next.json.date, 'expects an open day within two weeks');
  assert.ok(next.json.barbers.length > 0);
});

test('security headers are set and unknown API paths 404', async () => {
  const r = await call('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const wrong = await call('DELETE', '/api/services');
  assert.equal(wrong.status, 405);
});

test('registration validates input and rejects duplicates', async () => {
  const bad = await call('POST', '/api/auth/register', { body: { name: 'A', email: 'nope', password: 'short' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.fields.name && bad.json.fields.email && bad.json.fields.password);

  const ok = await call('POST', '/api/auth/register', {
    body: { name: 'Ali Raza', email: 'Ali@Example.com', phone: '+44 7700 900123', password: 'a-good-password' },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.user.email, 'ali@example.com');
  assert.ok(ok.cookie, 'session cookie set');

  const dup = await call('POST', '/api/auth/register', { body: { name: 'Ali Two', email: 'ali@example.com', password: 'another-password' } });
  assert.equal(dup.status, 409);
  assert.ok(dup.json.fields.email);

  const me = await call('GET', '/api/auth/me', { cookie: ok.cookie });
  assert.equal(me.json.user.name, 'Ali Raza');
  const anon = await call('GET', '/api/auth/me');
  assert.equal(anon.json.user, null);
});

test('session cookie is HttpOnly and SameSite', async () => {
  const r = await call('POST', '/api/auth/login', { body: { email: 'ali@example.com', password: 'a-good-password' } });
  assert.equal(r.status, 200);
  const raw = r.headers.getSetCookie()[0];
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
});

test('login rejects wrong passwords and logout ends the session', async () => {
  const wrong = await call('POST', '/api/auth/login', { body: { email: 'ali@example.com', password: 'wrong-password' } });
  assert.equal(wrong.status, 401);
  const unknown = await call('POST', '/api/auth/login', { body: { email: 'ghost@example.com', password: 'whatever-123' } });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.json.error, wrong.json.error, 'same message for unknown email and wrong password');

  const ok = await call('POST', '/api/auth/login', { body: { email: 'ali@example.com', password: 'a-good-password' } });
  assert.equal(ok.status, 200);
  const out = await call('POST', '/api/auth/logout', { cookie: ok.cookie });
  assert.equal(out.status, 200);
  const after = await call('GET', '/api/auth/me', { cookie: ok.cookie });
  assert.equal(after.json.user, null, 'old cookie no longer works');
});

test('bookings need an account', async () => {
  const r = await call('POST', '/api/bookings', { body: { serviceId: 1, date: '2030-01-01', time: '10:00' } });
  assert.equal(r.status, 401);
});

test('cross-site writes are blocked', async () => {
  const r = await call('POST', '/api/auth/login', {
    body: { email: 'ali@example.com', password: 'a-good-password' },
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(r.status, 403);
});

test('booking, double-booking protection, overlap and cancel', async () => {
  const { date, slot, prev } = await findDay();
  const [first, second] = slot.barberIds;
  const a = await register('Customer A', 'a@example.com');
  const b = await register('Customer B', 'b@example.com');
  const c = await register('Customer C', 'c@example.com');

  // A books barber `first` at the slot.
  const booked = await call('POST', '/api/bookings', { cookie: a, body: { serviceId: 1, barberId: first, date, time: slot.time } });
  assert.equal(booked.status, 201, JSON.stringify(booked.json));
  assert.equal(booked.json.booking.barber.id, first);
  assert.equal(booked.json.booking.status, 'booked');

  // B cannot take the same barber and time.
  const clash = await call('POST', '/api/bookings', { cookie: b, body: { serviceId: 1, barberId: first, date, time: slot.time } });
  assert.equal(clash.status, 409);

  // The slot no longer shows for that barber.
  const avail = await call('GET', `/api/availability?date=${date}&serviceId=1&barberId=${first}`);
  assert.ok(!avail.json.slots.some((s) => s.time === slot.time));

  // A 60-minute service starting just before would overlap, so it is not offered or accepted.
  const long = await call('GET', `/api/availability?date=${date}&serviceId=4&barberId=${first}`);
  assert.ok(!long.json.slots.some((s) => s.time === prev.time), 'overlapping start is hidden');
  const overlap = await call('POST', '/api/bookings', { cookie: c, body: { serviceId: 4, barberId: first, date, time: prev.time } });
  assert.equal(overlap.status, 409);

  // "Any barber" gives B someone else.
  const any = await call('POST', '/api/bookings', { cookie: b, body: { serviceId: 1, barberId: 'any', date, time: slot.time } });
  assert.equal(any.status, 201);
  assert.notEqual(any.json.booking.barber.id, first);
  assert.ok(slot.barberIds.includes(any.json.booking.barber.id));

  // A cannot double-book themselves at the same time with another barber.
  const self = await call('POST', '/api/bookings', { cookie: a, body: { serviceId: 1, barberId: second, date, time: slot.time } });
  assert.equal(self.status, 409);

  // Lists are private to each customer.
  const mineA = await call('GET', '/api/bookings/mine', { cookie: a });
  assert.equal(mineA.json.upcoming.length, 1);
  assert.equal(mineA.json.upcoming[0].canCancel, true);
  const mineC = await call('GET', '/api/bookings/mine', { cookie: c });
  assert.equal(mineC.json.upcoming.length, 0);

  // Nobody else can cancel A's booking; A can.
  const stolen = await call('POST', `/api/bookings/${booked.json.booking.id}/cancel`, { cookie: b });
  assert.equal(stolen.status, 404);
  const cancelled = await call('POST', `/api/bookings/${booked.json.booking.id}/cancel`, { cookie: a });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.booking.status, 'cancelled');

  // The slot opens up again.
  const reopened = await call('GET', `/api/availability?date=${date}&serviceId=1&barberId=${first}`);
  assert.ok(reopened.json.slots.some((s) => s.time === slot.time));

  // Past or out-of-range dates are refused.
  const past = await call('POST', '/api/bookings', { cookie: a, body: { serviceId: 1, barberId: first, date: '2020-01-06', time: '10:00' } });
  assert.equal(past.status, 400);
  const bad = await call('POST', '/api/bookings', { cookie: a, body: { serviceId: 1, barberId: first, date, time: '25:99' } });
  assert.equal(bad.status, 400);

  // Stash for the admin test.
  global.__bookingForAdmin = { date, id: any.json.booking.id };
});

test('admin routes are staff-only and manage bookings and prices', async () => {
  const customer = await register('Plain Customer', 'plain@example.com');
  assert.equal((await call('GET', '/api/admin/summary', { cookie: customer })).status, 403);
  assert.equal((await call('GET', '/api/admin/summary')).status, 401);

  const login = await call('POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'owner-pass-123' } });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.role, 'admin');
  const admin = login.cookie;

  const { date, id } = global.__bookingForAdmin;
  const summary = await call('GET', `/api/admin/summary?date=${date}`, { cookie: admin });
  assert.equal(summary.status, 200);
  const row = summary.json.bookings.find((x) => x.id === id);
  assert.ok(row, 'booking appears on the day');
  assert.equal(row.customer.email, 'b@example.com');

  const done = await call('PATCH', `/api/admin/bookings/${id}`, { cookie: admin, body: { status: 'completed' } });
  assert.equal(done.json.booking.status, 'completed');
  const after = await call('GET', `/api/admin/summary?date=${date}`, { cookie: admin });
  assert.ok(after.json.stats.earnedCents > 0);

  const invalid = await call('PATCH', `/api/admin/bookings/${id}`, { cookie: admin, body: { status: 'exploded' } });
  assert.equal(invalid.status, 400);

  const patched = await call('PATCH', '/api/admin/services/1', { cookie: admin, body: { priceCents: 3000 } });
  assert.equal(patched.json.service.priceCents, 3000);

  // A price range: the highest price must be above the lowest, and null clears it.
  const range = await call('PATCH', '/api/admin/services/1', { cookie: admin, body: { priceMaxCents: 5000 } });
  assert.equal(range.json.service.priceMaxCents, 5000);
  const badRange = await call('PATCH', '/api/admin/services/1', { cookie: admin, body: { priceMaxCents: 2000 } });
  assert.equal(badRange.status, 400);
  assert.ok(badRange.json.fields.priceMaxCents);
  const cleared = await call('PATCH', '/api/admin/services/1', { cookie: admin, body: { priceMaxCents: null } });
  assert.equal(cleared.json.service.priceMaxCents, null);
  const pub = await call('GET', '/api/services');
  assert.equal(pub.json.services.find((s) => s.id === 1).priceCents, 3000);

  const created = await call('POST', '/api/admin/services', { cookie: admin, body: { name: 'Eyebrow tidy', description: '', durationMin: 30, priceCents: 800 } });
  assert.equal(created.status, 201);
  const hidden = await call('PATCH', `/api/admin/services/${created.json.service.id}`, { cookie: admin, body: { active: false } });
  assert.equal(hidden.json.service.active, false);
  const pub2 = await call('GET', '/api/services');
  assert.ok(!pub2.json.services.some((s) => s.name === 'Eyebrow tidy'), 'inactive services are not public');

  const oddLength = await call('POST', '/api/admin/services', { cookie: admin, body: { name: 'Bad length', durationMin: 45, priceCents: 100 } });
  assert.equal(oddLength.status, 400);
});

test('repeated wrong passwords are rate limited', async () => {
  for (let i = 0; i < 8; i++) {
    const r = await call('POST', '/api/auth/login', { body: { email: 'victim@example.com', password: `wrong-${i}-password` } });
    assert.equal(r.status, 401);
  }
  const locked = await call('POST', '/api/auth/login', { body: { email: 'victim@example.com', password: 'wrong-again-123' } });
  assert.equal(locked.status, 429);
});

test('oversized and malformed request bodies are rejected', async () => {
  const big = await call('POST', '/api/auth/login', { body: { email: 'x@example.com', password: 'x'.repeat(200 * 1024) } });
  assert.equal(big.status, 413);
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(res.status, 400);
  const wrongType = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'email=a' });
  assert.equal(wrongType.status, 415);
});

test('the shop is open all day: first and last slots of a day are bookable', async () => {
  const shop = await call('GET', '/api/shop');
  const date = addDays(shop.json.today, 3);
  const r = await call('GET', `/api/availability?date=${date}&serviceId=1&barberId=any`);
  assert.equal(r.status, 200);
  const times = r.json.slots.map((x) => x.time);
  assert.equal(times[0], '00:00');
  assert.equal(times[times.length - 1], '23:30');
  assert.equal(times.length, 48);
});

test('a booking keeps the price range of its service', async () => {
  const cookie = await register('Range Customer', 'range@example.com');
  const shop = await call('GET', '/api/shop');
  const date = addDays(shop.json.today, 5);
  const svc = (await call('GET', '/api/services')).json.services.find((s) => s.name === 'Facial');
  const made = await call('POST', '/api/bookings', { cookie, body: { serviceId: svc.id, barberId: 'any', date, time: '12:00' } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.booking.priceCents, 150000);
  assert.equal(made.json.booking.priceMaxCents, 600000);
});

test('manifest, service worker and pages use the shop details', async () => {
  const manifest = await call('GET', '/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.json.name, 'Gloria Hair Studio');
  const home = await call('GET', '/');
  assert.match(home.text, /Gloria Hair Studio/);
  assert.match(home.text, /tel:03141483381/);
  assert.match(home.text, /Open 24 hours, 365 days a year/);
  assert.doesNotMatch(home.text, /\{\{/, 'no unreplaced template tokens');
  assert.doesNotMatch(home.text, /mailto:/, 'no empty email link when no email is set');
  for (const file of ['/sw.js', '/js/theme.js', '/offline.html']) assert.equal((await call('GET', file)).status, 200, file);
});
