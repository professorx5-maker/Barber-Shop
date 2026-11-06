import { api, h, $, initChrome, getShop, priceRange, time12, dateLong, formatDays } from './app.js';

initChrome();

async function loadBoard() {
  const mount = $('#open-board');
  try {
    const [data, { shop }] = await Promise.all([api('/next-open'), getShop()]);

    if (!data.date) {
      mount.replaceChildren(
        h('div', { class: 'plate-head' }, h('h2', {}, 'Open chairs')),
        h('div', { class: 'plate-body' }, h('p', {}, `Nothing is open in the next two weeks. Call us on ${shop.phone} and we will look for a cancellation.`))
      );
      return;
    }

    const rows = data.barbers.map((b) => {
      const link = (extra) => `/book.html?barber=${b.id}&date=${data.date}${extra}`;
      const content = b.free
        ? h(
            'div',
            { class: 'chips' },
            b.times.map((t) => h('a', { class: 'chip', href: link(`&time=${t}`) }, time12(t))),
            b.more ? h('a', { class: 'chip chip-quiet', href: link('') }, `${b.more} more`) : null
          )
        : h('span', { class: 'muted' }, 'Fully booked');
      return h('div', { class: 'chair-row' }, h('span', { class: 'chair-name' }, b.name.split(' ')[0]), content);
    });

    mount.replaceChildren(
      h(
        'div',
        { class: 'plate-head' },
        h('h2', {}, data.isToday ? 'Open today' : 'Next open day'),
        h('span', { class: 'when' }, dateLong(data.date))
      ),
      h('div', { class: 'plate-body' }, rows),
      h('div', { class: 'plate-foot' }, h('a', { class: 'btn btn-sm', href: '/book.html' }, 'See every time'))
    );
  } catch {
    mount.replaceChildren(
      h('div', { class: 'plate-head' }, h('h2', {}, 'Open chairs')),
      h('p', { class: 'plate-body muted' }, 'We could not load open times just now. Refresh the page or call the shop.')
    );
  }
}

async function loadServices() {
  const list = $('#service-board');
  try {
    const [{ services }, { shop }] = await Promise.all([api('/services'), getShop()]);
    list.replaceChildren(
      ...services.map((s) =>
        h(
          'li',
          { class: 'svc-card' },
          h('img', { class: 'svc-pic', src: s.image, alt: '', width: '480', height: '320', loading: 'lazy' }),
          h(
            'div',
            { class: 'svc-body' },
            h('h3', {}, s.name),
            h('p', { class: 'svc-price' }, priceRange(s.priceCents, s.priceMaxCents, shop.currency)),
            h('p', { class: 'svc-meta' }, `${s.durationMin} min`),
            h('p', { class: 'svc-desc' }, s.description),
            h('a', { class: 'btn btn-sm', href: `/book.html?service=${s.id}`, 'aria-label': `Book ${s.name}` }, 'Book now')
          )
        )
      )
    );
  } catch {
    list.replaceChildren(h('li', {}, h('span', { class: 'muted' }, 'Prices could not load. Refresh the page.')));
  }
}

const initials = (name) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

async function loadBarbers() {
  const mount = $('#barber-list');
  try {
    const { barbers } = await api('/barbers');
    mount.replaceChildren(
      ...barbers.map((b) =>
        h(
          'article',
          { class: 'barber' },
          h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(b.name)),
          h('h3', {}, b.name),
          h('p', { class: 'specialty' }, b.specialty),
          b.bio ? h('p', {}, b.bio) : null,
          h('p', { class: 'days' }, `Works ${formatDays(b.worksDays)}`),
          h('a', { class: 'btn btn-sm', href: `/book.html?barber=${b.id}` }, `Book with ${b.name.split(' ')[0]}`)
        )
      )
    );
  } catch {
    mount.replaceChildren(h('p', { class: 'muted' }, 'Barbers could not load. Refresh the page.'));
  }
}

// The 24 hour dial: midnight at the top, a dot that travels round the day, and
// the live time in the shop's own timezone.
async function loadDial() {
  const mount = $('#dial');
  if (!mount) return;
  let info;
  try {
    info = await getShop();
  } catch {
    return;
  }
  const { timezone, hours } = info;
  const always = Object.values(hours).length === 7 && Object.values(hours).every((x) => x && x[0] === '00:00' && x[1] === '24:00');
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const toHHMM = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  const hand = h('div', { class: 'dial-hand' }, h('span', { class: 'dial-dot' }));
  const state = h('span', { class: 'dial-state' });
  const time = h('span', { class: 'dial-time' });
  const note = h('span', { class: 'dial-note' });
  const dial = h(
    'div',
    { class: 'dial', role: 'img' },
    h('div', { class: 'dial-ring' }),
    hand,
    h('div', { class: 'dial-center' }, state, time, note),
    h('span', { class: 'dial-mark m-top' }, '12 am'),
    h('span', { class: 'dial-mark m-right' }, '6 am'),
    h('span', { class: 'dial-mark m-bottom' }, '12 pm'),
    h('span', { class: 'dial-mark m-left' }, '6 pm')
  );
  mount.replaceChildren(dial);

  function tick() {
    const p = Object.fromEntries(clock.formatToParts(new Date()).map((x) => [x.type, x.value]));
    const minutes = Number(p.hour) * 60 + Number(p.minute);
    const today = hours[DAYS.indexOf(p.weekday)];
    const open = always || (today && minutes >= toMin(today[0]) && minutes < toMin(today[1]));
    const label = time12(toHHMM(minutes));
    hand.style.transform = `rotate(${(minutes / 1440) * 360}deg)`;
    state.textContent = open ? 'Open now' : 'Closed now';
    time.textContent = label;
    note.textContent = always ? '24 hours, 365 days' : today ? `Today ${time12(today[0])} to ${time12(today[1] === '24:00' ? '23:59' : today[1])}` : 'Closed today';
    dial.classList.toggle('is-closed', !open);
    dial.setAttribute('aria-label', `${open ? 'Open now' : 'Closed now'}. The time at the shop is ${label}.`);
  }
  tick();
  setInterval(tick, 30000);
}

loadBoard();
loadServices();
loadBarbers();
loadDial();
