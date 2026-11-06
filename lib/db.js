'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL,
  price_cents  INTEGER NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS barbers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  specialty  TEXT NOT NULL DEFAULT '',
  bio        TEXT NOT NULL DEFAULT '',
  works_days TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bookings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  barber_id   INTEGER NOT NULL REFERENCES barbers(id),
  service_id  INTEGER NOT NULL REFERENCES services(id),
  date        TEXT NOT NULL,
  start_min   INTEGER NOT NULL,
  end_min     INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','completed','cancelled','no_show')),
  notes       TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_barber_date ON bookings(barber_id, date);
CREATE INDEX IF NOT EXISTS idx_bookings_user_date ON bookings(user_id, date);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
`);

// Older databases get new columns added in place, so existing data is kept.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn('services', 'price_max_cents', 'INTEGER'); // top of a price range, when a service has one
ensureColumn('services', 'image', "TEXT NOT NULL DEFAULT 'default'"); // picture name in public/images/services
ensureColumn('bookings', 'price_max_cents', 'INTEGER');

// Run fn inside one write transaction; roll back if it throws.
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

// Starting content so the site is usable on first run. Prices are in rupees and
// stored x100 (so 100 rupees is 10000). The picture name matches a file in
// public/images/services: drop in a photo with the same name (for example
// haircut.jpg) and it is used instead of the drawing.
// Services can be edited later in the admin page.
function seed() {
  if (!db.prepare('SELECT COUNT(*) AS n FROM services').get().n) {
    const insert = db.prepare(
      'INSERT INTO services (name, description, duration_min, price_cents, price_max_cents, image, sort) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    // name, description, minutes, lowest price, highest price (or null), picture
    [
      ['Simple cutting', 'A clean scissor or clipper cut, finished neatly.', 30, 100, null, 'haircut'],
      ['Beard', 'Beard trimmed, shaped and lined up.', 30, 100, null, 'beard'],
      ['Shave', 'A clean, smooth shave.', 30, 100, null, 'shave'],
      ['Fade cutting', 'A smooth fade blended into your length of choice, lined up and styled.', 60, 300, null, 'fade-cut'],
      ['Fade beard', 'Beard faded smoothly into the hairline and shaped.', 30, 200, null, 'fade-beard'],
      ['Face massage', 'A relaxing face massage. The price depends on the massage you choose.', 30, 200, 1000, 'face-massage'],
      ['Manicure and pedicure', 'Hand and foot care for clean, neat nails. The price depends on the treatment.', 90, 1500, 2500, 'mani-pedi'],
      ['Facial', 'A deep-cleansing facial for fresh skin. The price depends on the facial you choose.', 60, 1500, 6000, 'facial'],
      ['Hair protein treatment', 'A protein treatment to restore strength and softness to dry hair.', 90, 1000, null, 'hair-protein'],
      ['Hair polish', 'A glossy finish for smooth, shiny hair.', 60, 700, null, 'hair-polish'],
    ].forEach((x, i) => insert.run(x[0], x[1], x[2], x[3] * 100, x[4] === null ? null : x[4] * 100, x[5], i));
  }

  if (!db.prepare('SELECT COUNT(*) AS n FROM barbers').get().n) {
    const insert = db.prepare('INSERT INTO barbers (name, specialty, bio, works_days) VALUES (?, ?, ?, ?)');
    // name, specialty, short bio (optional), days worked (0 = Sunday ... 6 = Saturday)
    ['Ali Abid', 'Fizi', 'Hamza', 'Zaman'].forEach((name) => insert.run(name, 'Professional barber', '', '0,1,2,3,4,5,6'));
  }
}

module.exports = { db, transaction, seed };
