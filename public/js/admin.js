import { api, h, $, initChrome, getShop, money, priceRange, time12, dateLong, addDaysStr, toast } from './app.js';

let shop;
let today;
let date;

function setDate(next) {
  date = next;
  $('#day-input').value = next;
  loadDay();
}

function buildToolbar() {
  const input = h('input', {
    class: 'input',
    type: 'date',
    id: 'day-input',
    'aria-label': 'Day',
    value: date,
    onchange: (event) => {
      if (event.target.value) setDate(event.target.value);
    },
  });
  $('#toolbar').replaceChildren(
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => setDate(addDaysStr(date, -1)) }, 'Previous day'),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => setDate(today) }, 'Today'),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => setDate(addDaysStr(date, 1)) }, 'Next day'),
    input,
    h('span', { class: 'day-label', id: 'day-label' })
  );
}

function stat(value, label) {
  return h('div', { class: 'stat' }, h('div', { class: 'v' }, value), h('div', { class: 'l' }, label));
}

async function setStatus(id, status) {
  try {
    await api(`/admin/bookings/${id}`, { method: 'PATCH', body: { status } });
    toast('Booking updated.');
    await loadDay();
  } catch (err) {
    toast(err.message, true);
  }
}

function actionsFor(b) {
  const button = (label, status, cls = '') =>
    h('button', { class: `btn btn-sm ${cls}`.trim(), type: 'button', onclick: () => setStatus(b.id, status) }, label);

  if (b.status === 'booked') {
    return [button('Complete', 'completed'), button('No-show', 'no_show'), button('Cancel', 'cancelled', 'btn-danger')];
  }
  if (b.status === 'completed') return [button('Undo', 'booked')];
  return [button('Restore', 'booked')];
}

const STATUS_TEXT = { booked: 'Booked', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show' };

function renderTable(bookings) {
  const body = $('#bookings');
  if (!bookings.length) {
    body.replaceChildren(h('tr', {}, h('td', { colspan: '6' }, 'No bookings on this day.')));
    return;
  }
  body.replaceChildren(
    ...bookings.map((b) =>
      h(
        'tr',
        {},
        h('td', { 'data-label': 'Time' }, `${time12(b.startTime)} to ${time12(b.endTime)}`),
        h(
          'td',
          { 'data-label': 'Customer' },
          h('strong', {}, b.customer.name),
          h('span', { class: 'sub' }, b.customer.phone || 'No phone number'),
          h('a', { class: 'sub', href: `mailto:${b.customer.email}` }, b.customer.email),
          b.notes ? h('span', { class: 'sub' }, `Note: ${b.notes}`) : null
        ),
        h('td', { 'data-label': 'Service' }, b.service.name, h('span', { class: 'sub' }, priceRange(b.priceCents, b.priceMaxCents, shop.currency))),
        h('td', { 'data-label': 'Barber' }, b.barber.name),
        h('td', { 'data-label': 'Status' }, h('span', { class: `badge badge-${b.status}` }, STATUS_TEXT[b.status])),
        h('td', { 'data-label': 'Actions' }, h('div', { class: 'row-actions' }, actionsFor(b)))
      )
    )
  );
}

async function loadDay() {
  const requested = date;
  try {
    const data = await api(`/admin/summary?date=${requested}`);
    if (requested !== date) return; // a newer day was picked meanwhile
    $('#day-label').textContent = `${dateLong(requested)}${requested === today ? ' (today)' : ''}`;
    $('#stats').replaceChildren(
      stat(String(data.stats.dayCount), 'Bookings this day'),
      stat(money(data.stats.expectedCents, shop.currency), 'Expected takings'),
      stat(money(data.stats.earnedCents, shop.currency), 'Completed so far'),
      stat(String(data.stats.upcomingCount), 'Upcoming bookings'),
      stat(String(data.stats.customers), 'Customers')
    );
    renderTable(data.bookings);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- services ----------

function field(label, control) {
  return h('label', { class: 'svc-f' }, h('span', { class: 'svc-l' }, label), control);
}

function serviceRow(s) {
  const name = h('input', { class: 'input', type: 'text', maxlength: '60', value: s ? s.name : '', placeholder: 'Service name' });
  const rupees = (cents) => (Number.isInteger(cents / 100) ? String(cents / 100) : (cents / 100).toFixed(2));
  const price = h('input', { class: 'input', type: 'number', min: '0', step: '1', inputmode: 'decimal', value: s ? rupees(s.priceCents) : '' });
  const priceMax = h('input', { class: 'input', type: 'number', min: '0', step: '1', inputmode: 'decimal', placeholder: 'Optional', value: s && s.priceMaxCents ? rupees(s.priceMaxCents) : '' });

  const lengths = [30, 60, 90, 120, 150, 180];
  if (s && !lengths.includes(s.durationMin)) lengths.push(s.durationMin);
  const duration = h(
    'select',
    { class: 'input' },
    lengths.sort((a, b) => a - b).map((m) => h('option', { value: String(m), selected: (s ? s.durationMin : 30) === m ? true : null }, `${m} min`))
  );

  const active = h('input', { type: 'checkbox', checked: !s || s.active ? true : null });
  const save = h('button', { class: 'btn btn-sm btn-primary', type: 'button' }, s ? 'Save' : 'Add service');

  save.addEventListener('click', async () => {
    const priceCents = Math.round(parseFloat(price.value) * 100);
    if (!Number.isFinite(priceCents) || priceCents < 0) {
      toast('Enter a price like 100 or 1500.', true);
      price.focus();
      return;
    }
    const maxText = priceMax.value.trim();
    const priceMaxCents = maxText === '' ? null : Math.round(parseFloat(maxText) * 100);
    if (priceMaxCents !== null && (!Number.isFinite(priceMaxCents) || priceMaxCents <= priceCents)) {
      toast('The highest price must be more than the lowest price, or leave it empty.', true);
      priceMax.focus();
      return;
    }
    const body = { name: name.value.trim(), priceCents, priceMaxCents, durationMin: Number(duration.value), active: active.checked };
    save.disabled = true;
    try {
      if (s) await api(`/admin/services/${s.id}`, { method: 'PATCH', body });
      else await api('/admin/services', { method: 'POST', body: { ...body, description: '' } });
      toast(s ? 'Service saved.' : 'Service added.');
      await loadServices();
    } catch (err) {
      toast((err.fields && Object.values(err.fields)[0]) || err.message, true);
      save.disabled = false;
    }
  });

  return h(
    'div',
    { class: `svc-row${s ? '' : ' is-new'}` },
    field('Name', name),
    field(`Price (${shop.currency})`, price),
    field('Highest price', priceMax),
    field('Length', duration),
    h('label', { class: 'svc-active' }, active, 'On'),
    save
  );
}

async function loadServices() {
  try {
    const { services } = await api('/admin/services');
    $('#services-admin').replaceChildren(
      h('div', { class: 'svc-head', 'aria-hidden': 'true' }, h('span', {}, 'Name'), h('span', {}, `Price (${shop.currency})`), h('span', {}, 'Highest price'), h('span', {}, 'Length'), h('span', {}, 'Visible'), h('span', {})),
      ...services.map(serviceRow),
      serviceRow(null)
    );
  } catch (err) {
    toast(err.message, true);
  }
}

async function main() {
  const user = await initChrome();
  if (!user) return location.replace('/login.html?next=%2Fadmin.html');
  if (user.role !== 'admin') return location.replace('/');

  const info = await getShop();
  shop = info.shop;
  today = info.today;
  date = today;
  buildToolbar();
  await Promise.all([loadDay(), loadServices()]);
}

main();
