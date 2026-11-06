'use strict';
const { db } = require('./db');
const config = require('../config');

// Dates are 'YYYY-MM-DD' strings and times are minutes after midnight, both in
// the shop's own timezone, so the server never depends on the customer's clock.

const clock = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function nowInShop() {
  const p = Object.fromEntries(clock.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weekday(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function inWindow(date) {
  const today = nowInShop().date;
  return date >= today && date <= addDays(today, config.bookingWindowDays);
}

// Minutes from now until `minutes` after midnight on `date` (negative = past).
function minutesUntil(date, minutes) {
  const now = nowInShop();
  const [y, m, d] = date.split('-').map(Number);
  const [ny, nm, nd] = now.date.split('-').map(Number);
  const days = (Date.UTC(y, m - 1, d) - Date.UTC(ny, nm - 1, nd)) / 86400000;
  return days * 1440 + minutes - now.minutes;
}

function openHours(date) {
  const h = config.hours[weekday(date)];
  return h ? [toMin(h[0]), toMin(h[1])] : null;
}

function barberWorks(barber, date) {
  return barber.works_days.split(',').filter(Boolean).map(Number).includes(weekday(date));
}

// Start times (minutes) a barber can take a booking of `durationMin` on `date`.
function availableStarts(date, barber, durationMin) {
  const hours = openHours(date);
  if (!hours || !barberWorks(barber, date)) return [];

  const now = nowInShop();
  let earliest = -1;
  if (date === now.date) earliest = now.minutes + config.leadMinutes;
  else if (date < now.date) return [];

  const busy = db
    .prepare("SELECT start_min, end_min FROM bookings WHERE barber_id = ? AND date = ? AND status IN ('booked','completed')")
    .all(barber.id, date);

  const out = [];
  for (let s = hours[0]; s + durationMin <= hours[1]; s += config.slotMinutes) {
    if (s < earliest) continue;
    if (busy.some((b) => s < b.end_min && s + durationMin > b.start_min)) continue;
    out.push(s);
  }
  return out;
}

module.exports = {
  nowInShop,
  isValidDate,
  addDays,
  weekday,
  toMin,
  toHHMM,
  inWindow,
  minutesUntil,
  openHours,
  barberWorks,
  availableStarts,
};
