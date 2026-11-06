'use strict';
const path = require('path');

// Everything a shop owner is likely to change lives in this file.
module.exports = {
  shop: {
    name: 'Gloria Hair Studio',
    address: '', // add your street address here, for example 'Shop 4, Main Boulevard, Lahore'
    phone: '0314 1483381',
    email: '', // optional; leave empty to hide it on the site
    currency: 'PKR',
  },

  // Opening times are in the shop's own timezone (Pakistan by default).
  // Set SHOP_TZ (for example "Europe/London") to override.
  timezone: process.env.SHOP_TZ || 'Asia/Karachi',

  // Opening hours by weekday (0 = Sunday ... 6 = Saturday). null means closed.
  // The shop is open 24 hours, 365 days a year.
  hours: {
    0: ['00:00', '24:00'],
    1: ['00:00', '24:00'],
    2: ['00:00', '24:00'],
    3: ['00:00', '24:00'],
    4: ['00:00', '24:00'],
    5: ['00:00', '24:00'],
    6: ['00:00', '24:00'],
  },

  slotMinutes: 30, // booking grid; service durations must be multiples of this
  bookingWindowDays: 30, // how far ahead customers can book
  leadMinutes: 30, // earliest a customer can book from "now"
  cancelLeadMinutes: 60, // customers can cancel up to this long before the start
  maxActiveBookings: 5, // upcoming bookings one customer can hold at once
  sessionDays: 14,

  port: Number(process.env.PORT) || 3000,
  dbPath: process.env.DB_PATH || path.join(__dirname, 'data', 'barbershop.db'),
  trustProxy: process.env.TRUST_PROXY === '1', // set when running behind nginx, Caddy, etc.
};
