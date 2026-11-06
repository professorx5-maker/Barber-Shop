// Shared helpers for every page. All page content is built with textContent
// (never innerHTML), so names and notes typed by customers cannot inject markup.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Something went wrong. Try again in a moment.');
    err.status = res.status;
    err.fields = (data && data.fields) || {};
    throw err;
  }
  return data;
}

let shopPromise;
export function getShop() {
  shopPromise = shopPromise || api('/shop');
  return shopPromise;
}

// ---------- formatting ----------

// 150000 -> "1,500"; amounts are stored x100.
export function num(cents) {
  const value = cents / 100;
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// "PKR 1,500" for a word currency, "$25" for a symbol.
export function money(cents, currency = '$') {
  return currency.length > 1 ? `${currency} ${num(cents)}` : currency + num(cents);
}

// One price, or a range such as "PKR 200 to 1,000".
export function priceRange(low, high, currency = '$') {
  return high && high > low ? `${money(low, currency)} to ${num(high)}` : money(low, currency);
}

export function time12(hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'pm' : 'am'}`;
}

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDaysStr(s, n) {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const weekdayOf = (s) => parseDate(s).getUTCDay();

const fmt = (options) => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...options });
const longFmt = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const shortFmt = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
const dowFmt = fmt({ weekday: 'short' });
const monFmt = fmt({ month: 'short' });

export const dateLong = (s) => longFmt.format(parseDate(s));
export const dateShort = (s) => shortFmt.format(parseDate(s));
export const dayParts = (s) => ({
  dow: dowFmt.format(parseDate(s)),
  dom: parseDate(s).getUTCDate(),
  mon: monFmt.format(parseDate(s)),
});

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };

// [1,2,3,4,5,6] -> "Mon to Sat", [1,3,5] -> "Mon, Wed, Fri"
export function formatDays(days) {
  const set = DAY_ORDER.filter((d) => days.includes(d));
  if (!set.length) return '';
  if (set.length === 7) return 'every day';
  const idx = set.map((d) => DAY_ORDER.indexOf(d));
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (set.length >= 3 && contiguous) return `${DAY_NAMES[set[0]]} to ${DAY_NAMES[set[set.length - 1]]}`;
  return set.map((d) => DAY_NAMES[d]).join(', ');
}

// Only follow redirects to pages on this site.
export function safeNext(value, fallback = '/account.html') {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : fallback;
}

// ---------- page chrome ----------

let toastTimer;
export function toast(message, isError = false) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('is-error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

// Swaps the header's login link for the right account links. Returns the user or null.
// ---------- installable app (PWA) ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* the site still works without it */
    });
  });
}

// Browsers that support it let us show our own "Install app" link.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  document.querySelectorAll('[data-install]').forEach((el) => {
    el.hidden = false;
  });
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  document.querySelectorAll('[data-install]').forEach((el) => {
    el.hidden = true;
  });
});
document.addEventListener('click', async (event) => {
  const link = event.target.closest('[data-install] a');
  if (!link || !installPrompt) return;
  event.preventDefault();
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  link.closest('[data-install]').hidden = true;
});

export async function initChrome() {
  let user = null;
  try {
    ({ user } = await api('/auth/me'));
  } catch {
    /* treat as logged out */
  }

  const box = $('[data-auth]');
  if (box && user) {
    const items = [h('a', { class: 'link', href: '/account.html' }, 'My bookings')];
    if (user.role === 'admin') items.push(h('a', { class: 'link', href: '/admin.html' }, 'Admin'));
    items.push(
      h(
        'button',
        {
          class: 'link',
          type: 'button',
          onclick: async () => {
            try {
              await api('/auth/logout', { method: 'POST' });
            } finally {
              location.href = '/';
            }
          },
        },
        'Log out'
      ),
      h('a', { class: 'btn btn-primary btn-sm', href: '/book.html' }, 'Book a chair')
    );
    box.replaceChildren(...items);
  }
  return user;
}
