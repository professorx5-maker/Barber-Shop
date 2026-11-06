import { api, h, $, initChrome, getShop, priceRange, time12, dateShort, toast } from './app.js';

let shop;

function statusLabel(b) {
  if (b.status === 'booked') return 'Past';
  if (b.status === 'completed') return 'Completed';
  if (b.status === 'no_show') return 'Missed';
  return 'Cancelled';
}

// Two-step cancel so a stray tap cannot drop someone's chair.
function cancelControl(b) {
  const box = h('div', { class: 'row-actions' });

  const reset = () => {
    box.replaceChildren(h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: ask }, 'Cancel booking'));
  };

  async function confirmCancel(event) {
    event.currentTarget.disabled = true;
    try {
      await api(`/bookings/${b.id}/cancel`, { method: 'POST' });
      toast('Booking cancelled.');
      await load();
    } catch (err) {
      toast(err.message, true);
      reset();
    }
  }

  function ask() {
    const yes = h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: confirmCancel }, 'Yes, cancel it');
    box.replaceChildren(
      h('span', { class: 'muted' }, 'Cancel this booking?'),
      yes,
      h('button', { class: 'btn btn-sm', type: 'button', onclick: reset }, 'Keep it')
    );
    yes.focus();
  }

  reset();
  return box;
}

function bookingItem(b, isUpcoming) {
  let side;
  if (isUpcoming) {
    side = b.canCancel ? cancelControl(b) : h('span', { class: 'muted' }, `To change this one, call ${shop.phone}.`);
  } else {
    side = h('span', { class: `badge badge-${b.status === 'booked' ? 'cancelled' : b.status}` }, statusLabel(b));
  }

  return h(
    'li',
    { class: 'bitem' },
    h(
      'div',
      { class: 'bitem-when' },
      h('div', { class: 'd' }, dateShort(b.date)),
      h('div', { class: 't' }, `${time12(b.startTime)} to ${time12(b.endTime)}`)
    ),
    h(
      'div',
      { class: 'bitem-what' },
      h('strong', {}, b.service.name),
      h('p', {}, `With ${b.barber.name}, ${priceRange(b.priceCents, b.priceMaxCents, shop.currency)}`),
      b.notes ? h('p', {}, `Note: ${b.notes}`) : null
    ),
    h('div', { class: 'bitem-actions' }, side)
  );
}

function render(data) {
  const upcoming = $('#upcoming');
  const history = $('#history');

  upcoming.replaceChildren(
    data.upcoming.length
      ? h('ul', { class: 'blist' }, data.upcoming.map((b) => bookingItem(b, true)))
      : h('div', { class: 'empty' }, h('p', {}, 'You have no upcoming bookings.'), h('a', { class: 'btn btn-primary btn-sm', href: '/book.html' }, 'Book a chair'))
  );

  history.replaceChildren(
    data.history.length
      ? h('ul', { class: 'blist' }, data.history.map((b) => bookingItem(b, false)))
      : h('div', { class: 'empty' }, h('p', {}, 'Past visits will show up here.'))
  );
}

async function load() {
  try {
    render(await api('/bookings/mine'));
  } catch (err) {
    if (err.status === 401) return location.replace('/login.html?next=%2Faccount.html');
    $('#upcoming').replaceChildren(h('p', { class: 'form-error', role: 'alert' }, err.message));
  }
}

async function main() {
  const user = await initChrome();
  if (!user) return location.replace('/login.html?next=%2Faccount.html');
  shop = (await getShop()).shop;
  $('#who').textContent = `Signed in as ${user.name}, ${user.email}`;
  await load();
}

main();
