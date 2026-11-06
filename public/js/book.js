import { api, h, $, $$, initChrome, getShop, money, priceRange, time12, dateLong, dayParts, addDaysStr, weekdayOf, formatDays } from './app.js';

const STORE = 'cc-booking';
const STEPS = [
  { id: 'service', label: 'Service' },
  { id: 'barber', label: 'Barber' },
  { id: 'time', label: 'Time' },
  { id: 'confirm', label: 'Confirm' },
];

// barber is 'any', a barber id, or null until chosen.
const state = { step: 'service', serviceId: null, barber: null, date: null, time: null, notes: '' };

let info;
let shop;
let services = [];
let barbers = [];
let user = null;
let slotsData = null;
let showAllDays = false;
let banner = '';
let submitting = false;
let done = null;

const flow = $('#flow');
const panel = $('#panel');
const summaryEl = $('#summary');
const stepsEl = $('#steps');

const currentService = () => services.find((s) => s.id === state.serviceId) || null;
const currentBarber = () => (typeof state.barber === 'number' ? barbers.find((b) => b.id === state.barber) || null : null);
const barberLabel = () => (state.barber === 'any' ? 'Any barber' : currentBarber() ? currentBarber().name : '');

function save() {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(state));
  } catch {
    /* storage unavailable, the booking just will not survive a login redirect */
  }
}

function dayOk(date) {
  const wd = weekdayOf(date);
  if (!info.hours[wd]) return false;
  if (date < info.today || date > addDaysStr(info.today, info.bookingWindowDays)) return false;
  const b = currentBarber();
  return b ? b.worksDays.includes(wd) : barbers.some((x) => x.worksDays.includes(wd));
}

function restore() {
  const params = new URLSearchParams(location.search);
  let saved = {};
  try {
    saved = JSON.parse(sessionStorage.getItem(STORE) || '{}') || {};
  } catch {
    saved = {};
  }
  const pick = (key) => params.get(key) ?? saved[key] ?? null;

  const serviceId = Number(pick('service'));
  if (services.some((s) => s.id === serviceId)) state.serviceId = serviceId;

  const barber = pick('barber');
  if (barber === 'any') state.barber = 'any';
  else if (barbers.some((b) => String(b.id) === String(barber))) state.barber = Number(barber);

  const date = pick('date');
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) state.date = date;

  const time = pick('time');
  if (typeof time === 'string' && /^\d{2}:\d{2}$/.test(time)) state.time = time;

  state.notes = typeof saved.notes === 'string' ? saved.notes.slice(0, 200) : '';

  if (state.date && !dayOk(state.date)) {
    state.date = null;
    state.time = null;
  }
  const complete = state.serviceId && state.barber !== null && state.date && state.time;
  state.step = saved.step === 'confirm' && complete ? 'confirm' : 'service';
}

function focusTitle() {
  const title = $('.panel-title, .done-title', panel);
  if (title) title.focus();
}

function go(step) {
  state.step = step;
  save();
  render();
  focusTitle();
}

const ready = (step) => {
  if (step === 'service') return !!currentService();
  if (step === 'barber') return state.barber !== null;
  if (step === 'time') return !!(state.date && state.time);
  return true;
};

function syncContinue() {
  const button = $('#continue');
  if (button) button.disabled = !ready(state.step);
}

function markSelected() {
  $$('.choice', panel).forEach((label) => label.classList.toggle('is-selected', label.querySelector('input').checked));
}

// ---------- summary ----------

function summaryRow(label, value, extra) {
  return h(
    'div',
    { class: `row${extra ? ' ' + extra : ''}` },
    h('dt', {}, label),
    h('dd', { class: value ? '' : 'is-empty' }, value || 'Not chosen yet')
  );
}

function summaryList() {
  const s = currentService();
  let when = '';
  if (state.date && state.time) when = `${dateLong(state.date)}, ${time12(state.time)}`;
  else if (state.date) when = dateLong(state.date);
  return h(
    'dl',
    { class: 'summary-list' },
    summaryRow('Service', s ? `${s.name} (${s.durationMin} min)` : ''),
    summaryRow('Barber', barberLabel()),
    summaryRow('When', when),
    summaryRow('Price', s ? priceRange(s.priceCents, s.priceMaxCents, shop.currency) : '', 'total')
  );
}

function renderSummary() {
  summaryEl.replaceChildren(h('div', { class: 'plate-head' }, h('h2', {}, 'Your booking')), summaryList());
}

// ---------- steps bar ----------

function renderSteps() {
  stepsEl.hidden = !!done;
  const index = STEPS.findIndex((s) => s.id === state.step);
  stepsEl.replaceChildren(
    ...STEPS.map((s, i) => {
      const isCurrent = i === index;
      const isDone = i < index;
      return h(
        'li',
        {},
        h(
          'button',
          {
            class: `step${isDone ? ' is-done' : ''}`,
            type: 'button',
            'aria-current': isCurrent ? 'step' : null,
            disabled: !isDone && !isCurrent ? true : null,
            onclick: isDone ? () => go(s.id) : null,
          },
          h('span', { class: 'n' }, String(i + 1)),
          h('span', { class: 't' }, s.label)
        )
      );
    })
  );
}

// ---------- panels ----------

function backButton(step) {
  return h('button', { class: 'btn', type: 'button', onclick: () => go(step) }, 'Back');
}

function continueButton(onclick) {
  return h(
    'button',
    { class: 'btn btn-primary', type: 'button', id: 'continue', disabled: ready(state.step) ? null : true, onclick },
    'Continue'
  );
}

function choice({ name, value, checked, title, price, sub, image, onchange }) {
  const input = h('input', { type: 'radio', name, value: String(value), checked: checked ? true : null, onchange });
  return h(
    'label',
    { class: `choice${checked ? ' is-selected' : ''}${image ? ' has-img' : ''}` },
    input,
    image ? h('img', { class: 'choice-img', src: image, alt: '', width: '72', height: '72', loading: 'lazy' }) : null,
    h('span', { class: 'choice-title' }, title),
    price ? h('span', { class: 'choice-price' }, price) : null,
    h('span', { class: 'choice-sub' }, sub)
  );
}

function servicePanel() {
  const options = services.map((s) =>
    choice({
      name: 'service',
      value: s.id,
      checked: state.serviceId === s.id,
      title: s.name,
      price: priceRange(s.priceCents, s.priceMaxCents, shop.currency),
      sub: `${s.durationMin} min. ${s.description}`,
      image: s.image,
      onchange: () => {
        if (state.serviceId !== s.id) {
          state.serviceId = s.id;
          state.time = null;
          slotsData = null;
        }
        save();
        markSelected();
        renderSummary();
        syncContinue();
      },
    })
  );
  return h(
    'div',
    {},
    h('h2', { class: 'panel-title', tabindex: '-1' }, 'Choose a service'),
    banner ? h('p', { class: 'form-error', role: 'alert' }, banner) : null,
    h('fieldset', { class: 'choices' }, h('legend', { class: 'visually-hidden' }, 'Service'), options),
    h('div', { class: 'actions' }, continueButton(continueFromService))
  );
}

async function slotStillFree() {
  try {
    const query = new URLSearchParams({ date: state.date, serviceId: String(state.serviceId), barberId: String(state.barber) });
    const data = await api(`/availability?${query}`);
    return data.slots.some((s) => s.time === state.time);
  } catch {
    return false;
  }
}

async function continueFromService() {
  if (state.barber === null) return go('barber');
  if (state.date && state.time) {
    if (await slotStillFree()) return go('confirm');
    state.time = null;
    banner = 'That time is not open for the service you picked. Choose another time.';
  }
  go('time');
}

function barberPanel() {
  const anyOption = choice({
    name: 'barber',
    value: 'any',
    checked: state.barber === 'any',
    title: 'Any barber',
    sub: 'Whoever is free at your time. This gives you the most times to choose from.',
    onchange: () => chooseBarber('any'),
  });
  const options = barbers.map((b) =>
    choice({
      name: 'barber',
      value: b.id,
      checked: state.barber === b.id,
      title: b.name,
      sub: `${b.specialty}. Works ${formatDays(b.worksDays)}.`,
      onchange: () => chooseBarber(b.id),
    })
  );
  return h(
    'div',
    {},
    h('h2', { class: 'panel-title', tabindex: '-1' }, 'Choose a barber'),
    h('fieldset', { class: 'choices' }, h('legend', { class: 'visually-hidden' }, 'Barber'), anyOption, options),
    h('div', { class: 'actions' }, backButton('service'), continueButton(() => go('time')))
  );
}

function chooseBarber(value) {
  if (state.barber !== value) {
    state.barber = value;
    state.time = null;
    slotsData = null;
  }
  save();
  markSelected();
  renderSummary();
  syncContinue();
}

function timePanel() {
  if (state.date && !dayOk(state.date)) {
    state.date = null;
    state.time = null;
  }
  const total = info.bookingWindowDays + 1;
  const count = showAllDays ? total : Math.min(14, total);

  const days = [];
  for (let i = 0; i < count; i++) {
    const date = addDaysStr(info.today, i);
    const parts = dayParts(date);
    const ok = dayOk(date);
    days.push(
      h(
        'button',
        {
          type: 'button',
          class: 'day',
          'data-date': date,
          'aria-pressed': String(state.date === date),
          'aria-label': `${dateLong(date)}${ok ? '' : ', not available'}`,
          disabled: ok ? null : true,
          onclick: () => chooseDate(date),
        },
        h('span', { class: 'dow' }, i === 0 ? 'Today' : parts.dow),
        h('span', { class: 'dom' }, String(parts.dom)),
        h('span', { class: 'mon' }, parts.mon)
      )
    );
  }

  const node = h(
    'div',
    {},
    h('h2', { class: 'panel-title', tabindex: '-1' }, 'Pick a day and time'),
    banner ? h('p', { class: 'form-error', role: 'alert' }, banner) : null,
    h('div', { class: 'days', role: 'group', 'aria-label': 'Day' }, days),
    !showAllDays && total > count
      ? h(
          'button',
          {
            class: 'btn btn-sm more-days',
            type: 'button',
            onclick: () => {
              showAllDays = true;
              render();
            },
          },
          'Show later dates'
        )
      : null,
    h('div', { id: 'slots', 'aria-live': 'polite' }),
    h('div', { class: 'actions' }, backButton('barber'), continueButton(() => go('confirm')))
  );
  banner = '';
  return node;
}

function chooseDate(date) {
  state.date = date;
  state.time = null;
  slotsData = null;
  save();
  $$('.day', panel).forEach((d) => d.setAttribute('aria-pressed', String(d.dataset.date === date)));
  renderSummary();
  syncContinue();
  loadSlots();
}

function chooseTime(time) {
  state.time = time;
  save();
  $$('#slots .chip', panel).forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.time === time)));
  renderSummary();
  syncContinue();
}

async function loadSlots() {
  const box = $('#slots');
  if (!box) return;
  if (!state.date) {
    box.replaceChildren(h('p', { class: 'muted' }, 'Choose a day to see open times.'));
    return;
  }
  const date = state.date;
  box.replaceChildren(h('p', { class: 'muted' }, 'Checking open times'));
  try {
    const query = new URLSearchParams({ date, serviceId: String(state.serviceId), barberId: String(state.barber) });
    const data = await api(`/availability?${query}`);
    if (state.date !== date || state.step !== 'time') return;
    slotsData = data;
    renderSlots(box);
  } catch (err) {
    if (state.date === date) box.replaceChildren(h('p', { class: 'form-error', role: 'alert' }, err.message));
  }
}

function renderSlots(box) {
  const slots = slotsData.slots;
  let note = null;
  if (state.time && !slots.some((s) => s.time === state.time)) {
    state.time = null;
    save();
    renderSummary();
    syncContinue();
    note = h('p', { class: 'form-error', role: 'alert' }, 'That time is not open for this service. Pick another.');
  }

  if (!slots.length) {
    const message = slotsData.open ? `No open times on ${dateLong(state.date)}. Try another day.` : `We are closed on ${dateLong(state.date)}.`;
    box.replaceChildren(...[note, h('p', {}, message)].filter(Boolean));
    return;
  }

  const grid = h(
    'div',
    { class: 'slots', role: 'group', 'aria-label': `Open times on ${dateLong(state.date)}` },
    slots.map((s) =>
      h(
        'button',
        { type: 'button', class: 'chip', 'data-time': s.time, 'aria-pressed': String(state.time === s.time), onclick: () => chooseTime(s.time) },
        time12(s.time)
      )
    )
  );
  box.replaceChildren(...[note, grid].filter(Boolean));
}

function confirmPanel() {
  const notes = h('textarea', {
    class: 'input',
    id: 'notes',
    maxlength: '200',
    rows: '3',
    oninput: (event) => {
      state.notes = event.target.value;
      save();
    },
  });
  notes.value = state.notes;

  const error = h('p', { class: 'form-error', role: 'alert' }, banner);
  banner = '';

  const next = encodeURIComponent('/book.html');
  const actions = user
    ? h(
        'div',
        { class: 'actions' },
        backButton('time'),
        h('button', { class: 'btn btn-primary', type: 'button', id: 'confirm', onclick: submit }, 'Confirm booking')
      )
    : h(
        'div',
        {},
        h(
          'div',
          { class: 'notice' },
          h('p', {}, 'Log in or create an account to confirm. Your choices are saved.'),
          h(
            'div',
            { class: 'actions' },
            h('a', { class: 'btn btn-primary', href: `/login.html?next=${next}` }, 'Log in'),
            h('a', { class: 'btn', href: `/register.html?next=${next}` }, 'Create account')
          )
        ),
        h('div', { class: 'actions' }, backButton('time'))
      );

  return h(
    'div',
    {},
    h('h2', { class: 'panel-title', tabindex: '-1' }, 'Confirm your booking'),
    error,
    h('div', { class: 'plate confirm-plate' }, h('div', { class: 'plate-head' }, h('h2', {}, 'Your booking')), summaryList()),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'notes' }, 'Notes for your barber (optional)'),
      notes,
      h('p', { class: 'hint' }, 'For example: how short you want the sides.')
    ),
    actions
  );
}

async function submit(event) {
  if (submitting) return;
  const button = event.currentTarget;
  submitting = true;
  button.disabled = true;
  button.textContent = 'Booking';

  try {
    const { booking } = await api('/bookings', {
      method: 'POST',
      body: { serviceId: state.serviceId, barberId: state.barber, date: state.date, time: state.time, notes: state.notes.trim() },
    });
    try {
      sessionStorage.removeItem(STORE);
    } catch {
      /* ignore */
    }
    done = booking;
    render();
    focusTitle();
  } catch (err) {
    if (err.status === 401) {
      user = null;
      banner = 'Your session ended. Log in again to confirm.';
    } else if (/no longer available/i.test(err.message)) {
      banner = err.message;
      state.time = null;
      state.step = 'time';
      save();
    } else {
      banner = (err.fields && Object.values(err.fields)[0]) || err.message;
    }
    render();
  } finally {
    submitting = false;
  }
}

function donePanel(booking) {
  const lead = info.cancelLeadMinutes % 60 === 0 ? `${info.cancelLeadMinutes / 60} hour${info.cancelLeadMinutes === 60 ? '' : 's'}` : `${info.cancelLeadMinutes} minutes`;
  return h(
    'div',
    {},
    h('h2', { class: 'done-title', tabindex: '-1' }, 'You are booked.'),
    h(
      'div',
      { class: 'plate confirm-plate' },
      h('div', { class: 'plate-head' }, h('h2', {}, 'Your booking')),
      h(
        'dl',
        { class: 'summary-list' },
        summaryRow('Service', booking.service.name),
        summaryRow('Barber', booking.barber.name),
        summaryRow('When', `${dateLong(booking.date)}, ${time12(booking.startTime)}`),
        summaryRow('Price', priceRange(booking.priceCents, booking.priceMaxCents, shop.currency), 'total')
      )
    ),
    h('p', {}, `Pay at the shop. You can cancel from My bookings up to ${lead} before your time.`),
    h(
      'div',
      { class: 'actions' },
      h('a', { class: 'btn btn-primary', href: '/account.html' }, 'View my bookings'),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => {
            done = null;
            Object.assign(state, { step: 'service', serviceId: null, barber: null, date: null, time: null, notes: '' });
            slotsData = null;
            render();
            focusTitle();
          },
        },
        'Book another'
      )
    )
  );
}

// ---------- render ----------

function render() {
  flow.dataset.step = done ? 'done' : state.step;
  renderSteps();
  renderSummary();

  let node;
  if (done) node = donePanel(done);
  else if (state.step === 'barber') node = barberPanel();
  else if (state.step === 'time') node = timePanel();
  else if (state.step === 'confirm') node = confirmPanel();
  else node = servicePanel();
  panel.replaceChildren(node);

  if (!done && state.step === 'time') loadSlots();
  if (!done && state.step === 'confirm') save();
}

async function start() {
  try {
    const [u, shopInfo, serviceData, barberData] = await Promise.all([initChrome(), getShop(), api('/services'), api('/barbers')]);
    user = u;
    info = shopInfo;
    shop = shopInfo.shop;
    services = serviceData.services;
    barbers = barberData.barbers;
  } catch {
    panel.replaceChildren(h('p', { class: 'form-error', role: 'alert' }, 'Booking could not load. Refresh the page, or call the shop to book.'));
    return;
  }
  restore();
  render();
}

start();
