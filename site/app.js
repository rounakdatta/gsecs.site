import * as L from './lib.js';

// ---------------------------------------------------------------- state
const KEY = 'gsecs:v1';
const state = { bonds: [], byId: {}, asof: null, loaded: false, failed: false, store: read() };

function read() {
  try {
    const s = L.clean(JSON.parse(localStorage.getItem(KEY)));
    if (s) return s;
  } catch {}
  return { holdings: [], payments: [] };
}

function write() {
  localStorage.setItem(KEY, JSON.stringify(state.store));
}

const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => L.todayIso();
const held = () => state.store.holdings;

// ---------------------------------------------------------------- dom helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

const money = (x) => h('span', { class: 'amount' }, L.rupees(x));
const searchIcon = () =>
  s('svg', { class: 'icon', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    s('circle', { cx: 7, cy: 7, r: 4.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }),
    s('path', { d: 'M10.5 10.5 14 14', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }));

// ---------------------------------------------------------------- bonds
const bondOf = (h) => (h.kind === 'sgb' ? null : state.byId[h.bond]);
const nameOf = (h) => (h.kind === 'sgb' ? h.series : bondOf(h)?.name || h.name || 'A bond no longer listed');
const shortOf = (h) => (h.kind === 'sgb'
  ? h.series.replace(/^Sovereign Gold Bond\s*/i, 'SGB ').replace(/\bSeries\s*/i, '')
  : nameOf(h).replace(' GS ', ' ').replace(' GOI SGrB ', ' green ').replace('GOI FRB ', 'FRB '));
const outstanding = (b) => b.maturity > today();
const endOf = (hd) => L.endOf(hd, bondOf(hd)) || ''; // '' for a bond RBI's list no longer has
const auctionsOf = (b) => b.auctions.map(([auction, issued, isNew, price, yld, crore, coupon]) => ({ auction, issued, isNew: !!isNew, price, yld, crore, coupon }));

function haystack(b) {
  const c = b.coupon != null ? String(b.coupon) : '';
  const year = b.maturity.slice(0, 4);
  const words = { gs: 'government stock gs', sgrb: 'sovereign green bond sgrb', frb: 'floating rate bond frb', iib: 'inflation indexed bond iib' }[b.kind];
  return `${b.name} ${c} ${c.replace('.', '')} ${year} ${year.slice(2)} ${words}`.toLowerCase();
}

function searchBonds(q, { matured = false } = {}) {
  const tokens = q.toLowerCase().replace(/%/g, ' ').split(/\s+/).filter(Boolean);
  const pool = state.bonds.filter((b) => matured || outstanding(b));
  const hits = tokens.length ? pool.filter((b) => tokens.every((t) => b._hay.includes(t))) : pool;
  return hits;
}

const lastAuction = (b) => auctionsOf(b).at(-1);

// ---------------------------------------------------------------- the money
function ledger() {
  const t = today();
  const hs = held();
  const match = L.reconcile(state.store.payments, hs, state.byId);
  const claimed = new Map();
  for (const p of state.store.payments) {
    const m = match.get(p.id);
    if (m) claimed.set(L.dueKey(m.holding, m.due, m.kind), p);
  }
  const rows = hs.map((h) => {
    const due = L.paymentsOf(h, bondOf(h)).map((d) => {
      const paid = claimed.get(L.dueKey(h.id, d.date, d.kind));
      return { ...d, holding: h, paid, status: paid ? 'got' : d.on < t ? 'due' : 'soon' };
    });
    return { h, due, next: due.find((d) => !d.paid && d.on >= t) };
  });
  const upcoming = rows.flatMap((r) => r.due.filter((d) => !d.paid && d.on >= t)).sort((a, b) => a.on.localeCompare(b.on));
  if (upcoming[0]) for (const d of upcoming.filter((x) => x.on === upcoming[0].on)) d.status = 'next';
  const incomes = hs.map((h) => L.yearlyIncome(h, bondOf(h), t));
  const yearly = incomes.reduce((sum, x) => sum + (x || 0), 0);
  const fixed = incomes.filter((x) => x > 0).length;
  const floating = hs.filter((h, i) => incomes[i] === null);
  return { rows, upcoming, match, yearly, fixed, floating };
}

// ---------------------------------------------------------------- views
const main = () => document.getElementById('main');

function render() {
  const route = location.hash.replace(/^#/, '') || '/';
  for (const a of document.querySelectorAll('[data-nav]')) {
    const on = (a.dataset.nav === 'bonds') === route.startsWith('/bonds');
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const m = main();
  redraw = null;
  if (!state.loaded) {
    m.replaceChildren(state.failed ? failed() : '');
    return;
  }
  const bondId = route.match(/^\/bonds\/(.+)$/)?.[1];
  const view = bondId ? bondPage(decodeURIComponent(bondId)) : route.startsWith('/bonds') ? allBonds() : home();
  m.replaceChildren(...[view].flat().filter(Boolean)); // a section with nothing to show is null, not the word
  document.title = bondId && state.byId[decodeURIComponent(bondId)] ? `${state.byId[decodeURIComponent(bondId)].name} · gsecs` : 'gsecs · when your government bonds pay';
  document.querySelector('[data-action="backup"]').closest('li').hidden = !(held().length || state.store.payments.length);
  afterRender.forEach((f) => f());
  afterRender.length = 0;
}
const afterRender = [];
// Charts are drawn at the width they are given; the view on screen keeps the one to redraw.
let redraw = null;
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => redraw?.(), 80); });

function failed() {
  return h('div', { class: 'welcome' },
    h('h1', {}, 'The bond list didn’t load'),
    h('p', {}, 'Your bonds are safe in this browser. Check your connection and try again.'),
    h('button', { class: 'button', type: 'button', onclick: boot }, 'Try again'));
}

// First visit: the one thing to do is find a bond you hold.
function welcome() {
  const n = state.bonds.filter(outstanding).length;
  return h('section', { class: 'welcome' },
    h('h1', {}, 'When will my bonds pay?'),
    h('p', {}, 'Add the government bonds you hold and see every interest payment on one calendar.'),
    bondSearch({ autofocus: true, onPick: (b) => openHolding({ bond: b.id }) }),
    h('p', { class: 'aside' },
      'A gold bond? ', h('button', { class: 'link', type: 'button', onclick: () => openSgb() }, 'Add an SGB'),
      ' · or browse ', h('a', { href: '#/bonds' }, `all ${n} bonds on sale`)));
}

function home() {
  if (!held().length) return welcome();
  const t = today();
  const { rows, upcoming, yearly, fixed, floating, match } = ledger();
  const next = upcoming[0];
  const nextAll = upcoming.filter((d) => next && d.on === next.on);
  const known = nextAll.filter((d) => d.amount != null);
  const floats = floating.length ? `${fixed ? ', plus ' : ''}${floating.map(nameOf).join(' and ')} at a floating rate` : '';
  const out = [];
  out.push(h('section', { class: 'summary' },
    h('h1', { class: 'visually-hidden' }, 'Your bonds'),
    fixed ? [h('span', { class: 'big' }, L.rupees(yearly), h('span', { class: 'per' }, ' a year')),
      h('span', { class: 'muted' }, `from ${fixed} ${fixed === 1 ? 'bond' : 'bonds'}${floats}`)]
      : h('p', { class: 'muted' }, floating.length ? `${floats[0].toUpperCase()}${floats.slice(1)}.` : 'Your bonds have all matured.'),
    next && h('p', { class: 'next' }, 'Next: ',
      known.length ? [h('span', { class: 'amount' }, L.rupees(known.reduce((x, d) => x + d.amount, 0))), ' '] : null,
      h('time', { datetime: next.on }, next.on === t ? 'today' : next.on === L.addDays(t, 1) ? 'tomorrow' : `on ${L.sayDate(next.on, t)}`),
      ' from ', nextAll.map((d, i) => [i ? ' and ' : '', nameOf(d.holding)]))));
  out.push(gantt(rows, t));
  out.push(agenda(upcoming, t));
  out.push(holdingsList(rows, t));
  out.push(receivedList(t, match));
  return out;
}

// ---------------------------------------------------------------- the calendar
const ROW_H = 44;
const AXIS = 42; // a line of years above a line of months

// The calendar is drawn at the width it is given, so a phone sees a whole year at a glance rather
// than three months and a scrollbar. Where months get narrow, the amounts give way (the list
// below carries them) but the dots, which are the payments, always stay.
function gantt(rows, t) {
  const visible = rows
    .filter((r) => endOf(r.h) > L.shiftMonths(t, -2))
    .sort((a, b) => (a.next?.on || '9999').localeCompare(b.next?.on || '9999'));
  if (!visible.length) return null;
  const labels = h('div', { class: 'gantt-labels', 'aria-hidden': 'true' },
    visible.map((r) => h('a', { href: r.h.kind === 'sgb' ? '#/' : `#/bonds/${r.h.bond}`, tabindex: '-1', title: nameOf(r.h) },
      h('span', { class: 'name' }, shortOf(r.h)),
      h('span', { class: 'sub' }, r.h.kind === 'sgb' ? `${r.h.grams} g` : L.rupees(r.h.face)))));
  const canvas = h('div', { class: 'gantt-canvas' });
  const section = h('section', { class: 'gantt', style: `--row:${ROW_H}px;--axis:${AXIS}px`, 'aria-label': 'Calendar' }, labels, canvas);
  const draw = () => {
    const width = Math.floor(canvas.clientWidth);
    if (!width) return;
    canvas.replaceChildren(timeline(visible, t, width));
    section.dataset.months = canvas.firstChild.dataset.months;
  };
  afterRender.push(draw);
  redraw = draw;
  return section;
}
function timeline(visible, t, width) {
  const span = width >= 760 ? 15 : width >= 480 ? 13 : 12;
  const from = L.shiftMonths(t.slice(0, 8) + '01', span >= 13 ? -2 : -1);
  const to = L.shiftMonths(from, span);
  const monthW = width / span;
  const roomy = monthW >= 46; // room for an amount over every dot
  const letters = monthW < 34; // 'O' for October where a month is narrow
  const total = L.daysBetween(from, to);
  const x = (d) => (L.daysBetween(from, d) / total) * width;
  const height = AXIS + visible.length * ROW_H + 4;

  const grid = [];
  for (let i = 0; i <= span; i++) {
    const d = L.shiftMonths(from, i);
    const m = +d.slice(5, 7);
    const isYear = m === 1 || i === 0;
    // the year sits on its own line above its first month, so no month name ever has to make room
    grid.push(s('g', { class: 'month' },
      s('line', { x1: x(d), x2: x(d), y1: AXIS - 6, y2: height }),
      i < span && isYear && s('text', { x: x(d) + 3, y: 12, class: 'year' }, d.slice(0, 4)),
      i < span && s('text', { x: x(d) + 3, y: 28 }, letters ? L.monthName(m)[0] : L.monthName(m))));
  }
  const tx = x(t);
  const marks = visible.map((r, i) => {
    const y = AXIS + i * ROW_H + ROW_H / 2 + 5;
    const start = r.h.date > from ? r.h.date : from;
    const endRaw = endOf(r.h);
    const end = endRaw < to ? endRaw : to;
    const g = [s('line', { class: 'life', x1: x(start), x2: x(end), y1: y, y2: y })];
    for (const d of r.due.filter((d) => d.on >= from && d.on <= to)) {
      const cx = x(d.on);
      const anchor = cx > width - 34 ? 'end' : cx < 34 ? 'start' : 'middle';
      if (d.kind === 'interest') {
        const what = d.status === 'got' ? 'received' : d.on >= t ? 'due' : 'was due';
        g.push(s('g', { class: `pay ${d.status}` },
          s('title', {}, `${d.amount != null ? L.rupees(d.amount) : 'Interest'} ${what} on ${L.sayDate(d.on, t)} from ${nameOf(r.h)}`),
          s('circle', { cx, cy: y, r: d.status === 'next' ? 6 : 4.5 }),
          (roomy || d.status === 'next') && d.amount != null && s('text', { x: cx, y: y - 11, 'text-anchor': anchor }, L.rupees(d.amount))));
      } else {
        g.push(s('g', { class: 'pay back' },
          s('title', {}, `${nameOf(r.h)} matures on ${L.sayDate(d.on, t)}`),
          s('rect', { x: cx - 4.5, y: y - 4.5, width: 9, height: 9, transform: `rotate(45 ${cx} ${y})` }),
          roomy && d.amount != null && s('text', { x: cx, y: y - 12, 'text-anchor': anchor }, `${L.rupees(d.amount)} back`)));
      }
    }
    return s('g', {}, g);
  });
  return s('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'data-months': span,
    'aria-label': `Interest payments from ${L.sayMonth(from)} to ${L.sayMonth(L.shiftMonths(to, -1))}, one row per bond; the list below says the same.` },
    grid,
    s('g', { class: 'today' }, s('line', { x1: tx, x2: tx, y1: AXIS - 10, y2: height }), s('text', { x: tx + 4, y: AXIS - 2 }, 'today')),
    marks);
}

function agenda(upcoming, t) {
  const soon = upcoming.filter((d, i) => d.on <= L.shiftMonths(t, 12) && (i < 6 || d.on <= L.shiftMonths(t, 3)));
  if (!soon.length) return null;
  const byMonth = new Map();
  for (const d of soon) {
    const k = d.on.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(d);
  }
  return h('section', {},
    h('div', { class: 'section-head' }, h('h2', {}, 'Coming up')),
    h('ul', { class: 'plain agenda' },
      [...byMonth].map(([k, ds]) => [
        h('li', { class: 'month' },
          h('span', { class: 'label' }, L.sayMonth(k + '-01').replace(` ${t.slice(0, 4)}`, '')),
          ds.length > 1 && ds.every((d) => d.amount != null) && h('span', { class: 'total amount' }, L.rupees(ds.reduce((x, d) => x + d.amount, 0)))),
        ds.map((d) => h('li', { class: 'pay' },
          h('time', { class: 'when', datetime: d.on }, L.sayDate(d.on, t).replace(/ [A-Z][a-z]{2}( \d{4})?$/, '')),
          h('span', {}, nameOf(d.holding), d.kind !== 'interest' && h('span', { class: 'muted' }, ' matures')),
          d.amount != null ? money(d.amount) : h('span', { class: 'amount muted small' }, d.kind === 'maturity' ? 'at the gold price' : 'rate not set yet'))),
      ])));
}

const nb = (x) => x.replace(/ /g, '\u00a0');

function holdingsList(rows, t) {
  const yields = (h) => {
    const b = bondOf(h);
    if (!b || !h.price || b.kind === 'frb' || b.kind === 'iib') return null;
    return L.ytm(h.price, b.coupon, h.date, b.maturity);
  };
  return h('section', {},
    h('div', { class: 'section-head' },
      h('h2', {}, 'Your bonds'),
      h('div', { class: 'actions' },
        h('button', { class: 'link', type: 'button', 'data-key': 'add-bond', onclick: () => openHolding({}) }, 'Add a bond'),
        h('button', { class: 'link quiet', type: 'button', 'data-key': 'add-sgb', onclick: () => openSgb() }, 'Add a gold bond'))),
    h('ul', { class: 'plain' },
      [...rows].sort((a, b) => (endOf(a.h) || '9999').localeCompare(endOf(b.h) || '9999')).map(({ h: hd, due }) => {
        const b = bondOf(hd);
        const got = due.filter((d) => d.paid).reduce((x, d) => x + d.paid.amount, 0);
        const nGot = due.filter((d) => d.paid).length;
        const y = yields(hd);
        const end = endOf(hd);
        const matured = end && end <= t;
        const days = (m) => L.payDays(m).split(' and ').map(nb).join(' and ');
        const pays = !b ? null
          : b.kind === 'frb' ? `pays on ${days(b.maturity)} at a rate RBI resets every six months`
            : b.kind === 'iib' ? `pays on ${days(b.maturity)}, linked to inflation`
              : `pays ${L.rupees(hd.face * b.coupon / 200)} on ${days(b.maturity)}`;
        const facts = hd.kind === 'sgb'
          ? [`${hd.grams} g at ${L.rupees(hd.issuePrice)} a gram`, `pays ${L.rupees(L.sgbCoupon(hd))} every six months`, `${matured ? 'matured' : 'until'} ${nb(L.sayMonth(end))}`]
          : b ? [L.rupees(hd.face), pays, `${matured ? 'matured' : 'until'} ${nb(L.sayDate(b.maturity, t, { weekday: false }))}`]
            : [L.rupees(hd.face), 'RBI’s list no longer has this bond, so its payments can’t be worked out. Edit it to choose the bond again.'];
        const on = (d) => nb(L.sayDate(d, t, { weekday: false }));
        const bought = hd.kind === 'sgb' ? null
          : hd.how === 'auction'
            ? hd.isNew ? `bought new on ${on(hd.auction)}` : `bought at the ${on(hd.auction)} re-issue`
            : `bought on ${on(hd.date)}`;
        return h('li', { class: 'holding' },
          h('div', { class: 'top' },
            hd.kind === 'sgb' || !b ? h('span', { class: 'name' }, nameOf(hd)) : h('a', { class: 'name', href: `#/bonds/${hd.bond}` }, nameOf(hd)),
            h('div', { class: 'tools' },
              h('button', { class: 'link quiet', type: 'button', 'data-key': `edit-${hd.id}`, onclick: () => (hd.kind === 'sgb' ? openSgb(hd) : openHolding({ edit: hd })) }, 'Edit'),
              h('button', { class: 'link quiet', type: 'button', onclick: (e) => confirmRemove(e.target.closest('.holding'), hd, e.target) }, 'Remove'))),
          h('p', { class: 'facts' }, facts.map((f) => h('span', {}, f))),
          h('p', { class: 'facts' },
            bought && h('span', {}, bought + (hd.price ? ` at ${L.rupees(hd.price)}` : '')),
            y != null && h('span', {}, `yield ${L.percent(y)}`),
            nGot ? h('span', {}, `received ${L.rupees(got)} in ${nGot} ${nGot === 1 ? 'payment' : 'payments'}`) : null));
      })));
}

function confirmRemove(li, hd, from) {
  if (li.querySelector('.confirm')) return;
  const { match } = ledger();
  const its = state.store.payments.filter((p) => match.get(p.id)?.holding === hd.id);
  const box = h('div', { class: 'confirm', role: 'group', 'aria-label': `Remove ${nameOf(hd)}?` },
    h('span', {}, `Remove ${nameOf(hd)}?`, its.length ? ` The ${its.length === 1 ? 'payment' : `${its.length} payments`} you recorded from it stay under Received.` : ''),
    h('button', { class: 'button quiet', type: 'button', onclick: () => {
      // what it paid stays income you received, under its name, and is not matched to another bond
      for (const p of its) { p.label = nameOf(hd); delete p.holding; delete p.due; delete p.kind; }
      state.store.holdings = held().filter((x) => x.id !== hd.id);
      write();
      render();
      main().focus();
    } }, 'Remove'),
    h('button', { class: 'link quiet', type: 'button', onclick: () => { box.remove(); from.focus(); } }, 'Keep it'));
  li.append(box);
  box.querySelector('button').focus();
}

// Money that arrived, by Indian financial year — the period it is taxed in. The latest year is
// open; earlier years fold to their totals unless a payment in them still needs its bond.
function receivedList(t, match) {
  const pays = [...state.store.payments].sort((a, b) => b.date.localeCompare(a.date));
  const fy = (d) => {
    const y = +d.slice(0, 4);
    const start = +d.slice(5, 7) >= 4 ? y : y - 1;
    return `${start}–${String(start + 1).slice(2)}`;
  };
  const groups = new Map();
  for (const p of pays) {
    const k = fy(p.date);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const row = (p) => {
    const m = match.get(p.id);
    const hd = m && held().find((x) => x.id === m.holding);
    return h('li', {},
      h('button', { class: 'pay-row', type: 'button', 'aria-haspopup': 'dialog', 'data-key': `pay-${p.id}`, onclick: () => openPayment(p) },
        h('time', { class: 'when', datetime: p.date }, L.sayDate(p.date, t, { weekday: false })),
        hd ? h('span', {}, nameOf(hd)) : p.label ? h('span', { class: 'gone' }, p.label) : h('span', { class: 'ask' }, 'Which bond?'),
        money(p.amount)));
  };
  return h('section', { class: 'received' },
    h('div', { class: 'section-head' },
      h('h2', {}, 'Received'),
      h('div', { class: 'actions' },
        h('button', { class: 'link', type: 'button', 'data-key': 'record', onclick: () => openPayment() }, 'Record a payment'),
        h('button', { class: 'link quiet', type: 'button', 'data-key': 'paste', onclick: () => openPaste() }, 'Paste from a statement'))),
    !pays.length
      ? h('p', { class: 'empty-note' }, 'Note the interest that reaches your bank, and each credit is matched to its bond by amount and date.')
      : [...groups].map(([k, ps], i) => h('details', { class: 'fy', open: i === 0 || ps.some((p) => !match.get(p.id) && !p.label) },
        h('summary', {},
          h('span', { class: 'label' }, `FY ${k}`),
          h('span', { class: 'total amount' }, L.rupees(ps.reduce((x, p) => x + p.amount, 0)))),
        h('ul', { class: 'plain' }, ps.map(row)))));
}

// ---------------------------------------------------------------- all bonds
function allBonds() {
  const t = today();
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const q = params.get('q') || '';
  const matured = params.get('matured') === '1';
  const list = h('ul', { class: 'plain bonds' });
  const count = h('p', { class: 'visually-hidden', role: 'status' });
  const heldIds = new Set(held().map((x) => x.bond));
  const fill = () => {
    const hits = searchBonds(input.value, { matured: box.checked });
    count.textContent = `${hits.length} ${hits.length === 1 ? 'bond' : 'bonds'}`;
    list.replaceChildren(...(hits.length
      ? [h('li', { class: 'head', 'aria-hidden': 'true' }, h('span', {}), h('span', {}), h('span', {}, 'yield at its last auction')), ...hits.map((b) => {
        const last = lastAuction(b);
        return h('li', {},
          h('span', {}, h('a', { class: 'name', href: `#/bonds/${b.id}` }, b.name), heldIds.has(b.id) && h('span', { class: 'held' }, ' · yours')),
          h('span', { class: 'pays' }, outstanding(b) ? `pays ${L.payDays(b.maturity).split(' and ').map(nb).join(' and ')} · until ${nb(L.sayMonth(b.maturity))}` : `matured ${nb(L.sayDate(b.maturity, t, { weekday: false }))}`),
          h('span', { class: 'last', title: `Last sold at auction on ${L.sayDate(last.auction, t)}` },
            last.yld != null ? `${L.percent(last.yld)} ` : '', h('span', { class: 'muted' }, L.sayMonth(last.auction))));
      })]
      : [h('li', { class: 'none' }, h('p', { class: 'empty-note' }, `No bond matches “${input.value}”. `,
        h('button', { class: 'link', type: 'button', onclick: () => { input.value = ''; fill(); input.focus(); } }, 'Show all'),
        !box.checked ? [' or ', h('button', { class: 'link', type: 'button', onclick: () => { box.checked = true; fill(); } }, 'include matured ones')] : null))]));
    const p = new URLSearchParams();
    if (input.value) p.set('q', input.value);
    if (box.checked) p.set('matured', '1');
    history.replaceState(null, '', `#/bonds${p.size ? '?' + p : ''}`);
  };
  const input = h('input', { type: 'search', value: q, placeholder: 'e.g. 7.26 2033', 'aria-label': 'Find a bond', oninput: fill });
  const box = h('input', { type: 'checkbox', onchange: fill });
  box.checked = matured;
  fill();
  return [
    h('h1', {}, 'All bonds'),
    h('p', { class: 'muted' }, `Every Government of India bond auctioned since August 2012, as RBI announced it. The last auction was on ${L.sayDate(state.asof, t)}.`),
    h('div', { class: 'filters' }, h('div', { class: 'search' }, h('div', { class: 'box' }, searchIcon(), input)), h('label', {}, box, 'Matured too')),
    count,
    list,
  ];
}

function bondPage(id) {
  const b = state.byId[id];
  const t = today();
  if (!b) return [h('h1', {}, 'No such bond'), h('p', {}, h('a', { href: '#/bonds' }, 'See all bonds'))];
  const aus = auctionsOf(b);
  const mine = held().filter((x) => x.bond === id);
  const kind = { gs: 'Government stock', sgrb: 'Sovereign green bond', frb: 'Floating rate bond', iib: 'Inflation-indexed bond' }[b.kind];
  return [
    h('p', { class: 'label', style: 'margin:0 0 .2em' }, kind),
    h('h1', {}, b.name),
    h('dl', { class: 'facts-list' },
      h('dt', {}, 'Interest'), h('dd', {}, b.kind === 'frb' ? 'floating: RBI resets the rate every six months'
        : b.kind === 'iib' ? `${L.percent(b.coupon)} a year on a principal that grows with inflation` : `${L.percent(b.coupon)} a year`),
      h('dt', {}, 'Paid on'), h('dd', {}, L.payDays(b.maturity)),
      h('dt', {}, outstanding(b) ? 'Matures' : 'Matured'), h('dd', {}, L.sayDate(b.maturity, t, { weekday: false })),
      h('dt', {}, 'First issued'), h('dd', {}, L.sayDate(b.issued, t, { weekday: false }))),
    outstanding(b) && h('p', {},
      h('button', { class: 'button', type: 'button', onclick: () => openHolding({ bond: id }) }, mine.length ? 'I bought more' : 'I hold this bond'),
      mine.length ? h('span', { class: 'muted small' }, `  You hold ${L.rupees(mine.reduce((x, m) => x + m.face, 0))}.`) : null),
    h('div', { class: 'section-head' }, h('h2', {}, aus.length === 1 ? 'Its auction' : `Its ${aus.length} auctions`)),
    aus.length > 2 && sparkline(aus, t),
    h('div', { class: 'table-scroll' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, ''), h('th', { class: 'num' }, 'Sold'), h('th', { class: 'num' }, 'Price'), h('th', { class: 'num' }, 'Yield'))),
        h('tbody', {}, [...aus].reverse().map((a) => h('tr', {},
          h('td', {}, h('time', { datetime: a.auction }, L.sayDate(a.auction, t, { weekday: false }))),
          h('td', { class: 'muted' }, a.isNew ? 'new' : ''),
          h('td', { class: 'num' }, `${L.rupees(a.crore)} cr`),
          h('td', { class: 'num' }, a.price != null ? L.rupees(a.price) : '–'),
          h('td', { class: 'num' }, a.yld != null ? L.percent(a.yld, 4) : '–'))))))
  ];
}

// The yield at each auction, oldest to newest: how the market priced this bond over time.
function sparkline(aus, t) {
  const pts = aus.filter((a) => a.yld != null);
  if (pts.length < 2) return null;
  const box = h('div', { class: 'spark' });
  const draw = () => {
    const W = Math.floor(box.clientWidth);
    if (!W) return;
    const H = 84, P = 6, top = 6, bottom = 26;
    const ys = pts.map((a) => a.yld);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const t0 = pts[0].auction, span = Math.max(1, L.daysBetween(t0, pts.at(-1).auction));
    const X = (a) => P + (L.daysBetween(t0, a.auction) / span) * (W - 2 * P);
    const Y = (v) => (hi === lo ? (top + H - bottom) / 2 : top + ((hi - v) / (hi - lo)) * (H - top - bottom));
    const first = pts[0], last = pts.at(-1);
    box.replaceChildren(s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img',
      'aria-label': `Yield at auction, from ${L.percent(first.yld)} in ${L.sayMonth(first.auction)} to ${L.percent(last.yld)} in ${L.sayMonth(last.auction)}` },
      s('path', { d: pts.map((a, i) => `${i ? 'L' : 'M'}${X(a).toFixed(1)},${Y(a.yld).toFixed(1)}`).join('') }),
      pts.map((a) => s('circle', { cx: X(a), cy: Y(a.yld), r: a.isNew ? 3.5 : 2.5, class: a.isNew ? 'new' : null }, s('title', {}, `${L.percent(a.yld, 4)} on ${L.sayDate(a.auction, t)}`))),
      // the two ends, said under the line where nothing can cross them
      s('text', { x: P, y: H - 4 }, L.percent(first.yld), s('tspan', { class: 'axis' }, ` in ${L.sayMonth(first.auction)}`)),
      s('text', { x: W - P, y: H - 4, 'text-anchor': 'end' }, L.percent(last.yld), s('tspan', { class: 'axis' }, ` in ${L.sayMonth(last.auction)}`))));
  };
  afterRender.push(draw);
  redraw = draw;
  return box;
}

// ---------------------------------------------------------------- the search box
function bondSearch({ autofocus, onPick, value = '' }) {
  const id = 'b' + uid();
  const list = h('ul', { class: 'options', role: 'listbox', id: id + '-list', hidden: true });
  let hits = [];
  let active = -1;
  const show = () => {
    hits = input.value.trim() ? searchBonds(input.value).slice(0, 8) : [];
    active = hits.length ? 0 : -1;
    list.hidden = !hits.length;
    input.setAttribute('aria-expanded', String(!!hits.length));
    list.replaceChildren(...hits.map((b, i) => h('li', { role: 'option', id: `${id}-${i}`, 'aria-selected': String(i === active),
      onpointerdown: (e) => { e.preventDefault(); pick(i); } },
      h('span', {}, b.name), h('span', { class: 'meta' }, `pays ${L.payDays(b.maturity)}`))));
    mark();
  };
  const mark = () => {
    [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const pick = (i) => {
    const b = hits[i];
    if (!b) return;
    list.hidden = true;
    onPick(b);
  };
  const input = h('input', { type: 'search', value, role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': id + '-list',
    'aria-label': 'Find your bond', placeholder: 'Find your bond, e.g. 7.26 2033', autocomplete: 'off', oninput: show,
    onkeydown: (e) => {
      if (e.key === 'ArrowDown' && hits.length) { active = (active + 1) % hits.length; mark(); e.preventDefault(); }
      else if (e.key === 'ArrowUp' && hits.length) { active = (active - 1 + hits.length) % hits.length; mark(); e.preventDefault(); }
      else if (e.key === 'Enter' && active >= 0) { pick(active); e.preventDefault(); }
      else if (e.key === 'Escape' && !list.hidden) { list.hidden = true; e.stopPropagation(); e.preventDefault(); }
    } });
  if (autofocus && matchMedia('(pointer: fine)').matches) afterRender.push(() => input.focus({ preventScroll: true }));
  return h('div', { class: 'search' }, h('div', { class: 'box' }, searchIcon(), input), list);
}

// ---------------------------------------------------------------- sheets
const sheet = () => document.getElementById('sheet');

let opener = null;
function openSheet(title, body, actions) {
  const d = sheet();
  if (!d.open) opener = document.activeElement?.closest?.('[data-key]')?.dataset.key || null;
  d.replaceChildren(h('form', { class: 'sheet', method: 'dialog', novalidate: true, onsubmit: (e) => e.preventDefault() },
    h('header', {}, h('h2', { id: 'sheet-title' }, title),
      h('button', { class: 'link quiet', type: 'button', onclick: () => d.close() }, 'Close')),
    h('div', { class: 'body' }, body),
    h('footer', {}, actions)));
  if (!d.open) d.showModal();
  return d;
}

// The label names the input itself, even when a ₹ sits in front of it, and the hint describes it.
// Saved: close the sheet, redraw, and put focus back on what opened it (or the page, if that is gone).
function done() {
  sheet().close();
  render();
  const back = opener && document.querySelector(`[data-key="${CSS.escape(opener)}"]`);
  (back || main()).focus();
}

function field(label, control, { hint, id = 'f' + uid() } = {}) {
  const input = control.matches('input, select, textarea') ? control : control.querySelector('input, select, textarea');
  input.id = id;
  if (hint) input.setAttribute('aria-describedby', `${id}-hint`);
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint && h('span', { class: 'hint', id: `${id}-hint` }, hint));
}

const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(/,/g, '')));

function forgetStaleMatches(rec) {
  const dues = L.paymentsOf(rec, bondOf(rec));
  for (const p of state.store.payments) {
    if (p.holding === rec.id && !dues.some((d) => d.date === p.due && d.kind === (p.kind || 'interest'))) {
      delete p.holding; delete p.due; delete p.kind;
    }
  }
}

function openHolding({ bond, edit } = {}) {
  const t = today();
  const st = edit
    ? { ...edit }
    : { bond: bond || null, how: 'auction', face: null, date: null, price: null, auction: null };
  let first = true;
  const draw = (focus) => {
    const b = st.bond && state.byId[st.bond];
    const body = [];
    if (!b) {
      body.push(bondSearch({ autofocus: true, onPick: (x) => { st.bond = x.id; st.auction = null; draw(); } }));
      body.push(h('p', { class: 'hint', style: 'margin-top:.8em' }, 'Type the interest rate, the year it matures, or both.'));
    } else {
      body.push(h('div', { class: 'chosen' },
        h('span', {}, h('strong', {}, b.name), h('span', { class: 'muted small' }, ` · pays ${L.payDays(b.maturity)}`)),
        !edit && h('button', { class: 'link quiet', type: 'button', onclick: () => { st.bond = null; draw(); } }, 'Change')));
      const aus = auctionsOf(b).filter((a) => a.issued <= t).reverse();
      body.push(h('div', { class: 'choice', role: 'group', 'aria-label': 'How did you buy it?' },
        ['auction', 'market'].map((k) => h('button', { type: 'button', 'aria-pressed': String(st.how === k), 'data-focus': `how-${k}`,
          onclick: () => { st.how = k; if (k === 'market') { st.auction = null; } draw(`how-${k}`); } }, k === 'auction' ? 'At an RBI auction' : 'From the market'))));
      if (st.how === 'auction') {
        if (!st.auction && aus[0]) Object.assign(st, { auction: aus[0].auction, date: aus[0].issued, price: aus[0].price, isNew: aus[0].isNew });
        const sel = h('select', { 'data-focus': 'auction', onchange: () => {
          const a = aus.find((x) => x.auction === sel.value);
          Object.assign(st, { auction: a.auction, date: a.issued, price: a.price, isNew: a.isNew });
          draw('auction');
        } }, aus.map((a) => h('option', { value: a.auction, selected: a.auction === st.auction },
          `${L.sayDate(a.auction, t, { weekday: false })} · ${a.isNew ? 'new issue' : 're-issue'}${a.price ? ` · ${L.rupees(a.price)}` : ''}`)));
        body.push(field('Which auction?', sel, { hint: 'Retail bidders pay the average price of the auction, shown here.' }));
        body.push(field('Price you paid for ₹100', h('div', { class: 'prefix' }, h('span', {}, '₹'),
          h('input', { type: 'number', step: '0.01', min: '1', inputmode: 'decimal', value: st.price ?? '', oninput: (e) => { st.price = num(e.target.value); preview(); } }))));
      } else {
        body.push(h('div', { class: 'row' },
          field('Bought on', h('input', { type: 'date', max: t, value: st.date ?? '', oninput: (e) => { st.date = e.target.value || null; preview(); } })),
          field('Price for ₹100', h('div', { class: 'prefix' }, h('span', {}, '₹'),
            h('input', { type: 'number', step: '0.01', min: '1', inputmode: 'decimal', value: st.price ?? '', placeholder: '98.50', oninput: (e) => { st.price = num(e.target.value); preview(); } })))));
      }
      const faceInput = h('input', { type: 'number', step: '100', min: '100', inputmode: 'numeric', value: st.face ?? '', placeholder: '1,00,000',
        oninput: (e) => { st.face = num(e.target.value); preview(); } });
      body.push(field('Face value', h('div', { class: 'prefix' }, h('span', {}, '₹'), faceInput), { hint: 'What the bond repays at the end: 100 bonds of ₹100 is ₹10,000.' }));
      body.push(h('div', { class: 'preview', 'aria-live': 'polite' }));
      if (first && !edit && !st.face) afterRender.push(() => faceInput.focus());
    }
    const save = h('button', { class: 'button', type: 'button', onclick: () => {
      const b2 = st.bond && state.byId[st.bond];
      const bad = !b2 ? 'Pick a bond first.' : !(st.face > 0) ? 'Enter the face value.' : st.face % 100 ? 'Face value comes in steps of ₹100.' : !st.date ? 'Enter when you bought it.' : null;
      const out = sheet().querySelector('.complaint') || h('p', { class: 'complaint', role: 'alert' });
      if (bad) { out.textContent = bad; sheet().querySelector('.body').append(out); return; }
      const rec = { id: st.id || uid(), kind: 'gsec', bond: st.bond, name: b2.name, face: st.face, date: st.date, price: st.price || null, how: st.how,
        auction: st.how === 'auction' ? st.auction : null, isNew: st.how === 'auction' ? !!st.isNew : false };
      state.store.holdings = edit ? held().map((x) => (x.id === rec.id ? rec : x)) : [...held(), rec];
      if (edit) forgetStaleMatches(rec);
      write();
      if (location.hash.replace(/^#/, '') !== '/' && location.hash !== '') {
        sheet().close();
        location.hash = '#/';
      } else done();
    } }, edit ? 'Save' : 'Add to my bonds');
    openSheet(edit ? `Edit ${b ? b.name : 'bond'}` : 'Add a bond you hold', body, [
      h('button', { class: 'button quiet', type: 'button', onclick: () => sheet().close() }, 'Cancel'), save]);
    preview();
    afterRender.forEach((f) => f());
    afterRender.length = 0;
    if (focus) sheet().querySelector(`[data-focus="${focus}"]`)?.focus();
    first = false;
  };
  // What the person is about to save, in plain words: the payments, and what they paid.
  const preview = () => {
    const box = sheet().querySelector('.preview');
    const b = st.bond && state.byId[st.bond];
    if (!box || !b) return;
    const lines = [];
    const floats = b.kind === 'frb' || b.kind === 'iib';
    if (st.face > 0 && floats) {
      lines.push(h('p', {}, `Pays on ${L.payDays(b.maturity)} until ${L.sayMonth(b.maturity)}, then ${L.rupees(st.face)} back. `,
        b.kind === 'frb' ? 'RBI resets the rate every six months, so each amount is known only shortly before it is paid.' : 'Each amount follows inflation.'));
      if (st.price) lines.push(h('p', {}, `Cost ${L.rupees((st.face * st.price) / 100)}, plus any interest already earned.`));
    } else if (st.face > 0) {
      const half = (st.face * b.coupon) / 200;
      lines.push(h('p', {}, 'Pays ', h('strong', { class: 'amount' }, L.rupees(half)), ` on ${L.payDays(b.maturity)} until ${L.sayMonth(b.maturity)}, then ${L.rupees(st.face)} back.`));
      if (st.date && st.price) {
        const y = L.ytm(st.price, b.coupon, st.date, b.maturity);
        const acc = L.accrued(st.face, b.coupon, st.date, b.maturity, b.issued);
        lines.push(h('p', {}, `Cost ${L.rupees((st.face * st.price) / 100)}`,
          acc > 0.005 ? ` plus ${L.rupees(acc)} of interest already earned, which the first payment returns` : '',
          y != null ? `. Yield when bought: ${L.percent(y)}.` : '.'));
      }
    }
    box.hidden = !lines.length;
    box.replaceChildren(...lines);
  };
  draw();
}

function openSgb(edit) {
  const t = today();
  const st = edit ? { ...edit } : { series: '', grams: null, issuePrice: null, issueDate: null, date: null };
  const box = h('div', { class: 'preview', 'aria-live': 'polite', hidden: true });
  const preview = () => {
    if (!(st.grams > 0 && st.issuePrice > 0 && st.issueDate)) { box.hidden = true; return; }
    box.hidden = false;
    const per = L.sgbCoupon(st);
    const a = L.shiftMonths(st.issueDate, 6);
    box.replaceChildren(h('p', {}, 'Pays ', h('strong', { class: 'amount' }, L.rupees(per)),
      ` every six months (${L.sayDate(a, t, { weekday: false }).replace(/ \d{4}$/, '')} and ${L.sayDate(st.issueDate, t, { weekday: false }).replace(/ \d{4}$/, '')}) until ${L.sayMonth(L.shiftMonths(st.issueDate, 96))}.`));
  };
  const save = () => {
    const bad = !st.series.trim() ? 'Name the series, as on your statement.' : !(st.grams > 0) ? 'Enter how many grams.' : !(st.issuePrice > 0) ? 'Enter the issue price per gram.' : !st.issueDate ? 'Enter the issue date.' : null;
    const out = sheet().querySelector('.complaint') || h('p', { class: 'complaint', role: 'alert' });
    if (bad) { out.textContent = bad; sheet().querySelector('.body').append(out); return; }
    const rec = { id: st.id || uid(), kind: 'sgb', series: st.series.trim(), grams: st.grams, issuePrice: st.issuePrice, issueDate: st.issueDate, date: st.date || st.issueDate };
    state.store.holdings = edit ? held().map((x) => (x.id === rec.id ? rec : x)) : [...held(), rec];
    if (edit) forgetStaleMatches(rec);
    write();
    if (location.hash.replace(/^#/, '') !== '/' && location.hash !== '') {
      sheet().close();
      location.hash = '#/';
    } else done();
  };
  openSheet(edit ? `Edit ${edit.series}` : 'Add a gold bond', [
    field('Series', h('input', { type: 'text', value: st.series, placeholder: 'SGB 2023-24 Series II', oninput: (e) => { st.series = e.target.value; } })),
    h('div', { class: 'row' },
      field('Grams', h('input', { type: 'number', min: '1', step: '1', inputmode: 'numeric', value: st.grams ?? '', oninput: (e) => { st.grams = num(e.target.value); preview(); } })),
      field('Issue price a gram', h('div', { class: 'prefix' }, h('span', {}, '₹'),
        h('input', { type: 'number', min: '1', step: '0.01', inputmode: 'decimal', value: st.issuePrice ?? '', oninput: (e) => { st.issuePrice = num(e.target.value); preview(); } })))),
    h('div', { class: 'row' },
      field('Issued on', h('input', { type: 'date', value: st.issueDate ?? '', oninput: (e) => { st.issueDate = e.target.value || null; preview(); } })),
      field('You bought it on', h('input', { type: 'date', max: t, value: st.date ?? '', oninput: (e) => { st.date = e.target.value || null; } }), { hint: 'Leave empty if you bought it at issue.' })),
    box,
  ], [h('button', { class: 'button quiet', type: 'button', onclick: () => sheet().close() }, 'Cancel'),
    h('button', { class: 'button', type: 'button', onclick: save }, edit ? 'Save' : 'Add to my bonds')]);
  preview();
}

function openPayment(edit) {
  const t = today();
  const st = edit
    ? { date: edit.date, amount: edit.amount, narration: edit.narration || '', choice: edit.holding || '' }
    : { date: t, amount: null, narration: '', choice: '' };
  const hintBox = h('p', { class: 'hint', 'aria-live': 'polite' });
  const sel = h('select', { onchange: () => { st.choice = sel.value; } },
    h('option', { value: '' }, 'Work it out from the amount and date'),
    held().map((x) => h('option', { value: x.id, selected: x.id === st.choice }, nameOf(x))));
  const say = (hd, due, kind, verb) => `${verb} ${nameOf(hd)}’s ${kind === 'interest' ? `${L.sayDate(due, t, { weekday: false })} payment` : 'repayment'}.`;
  const guess = () => {
    if (!(st.amount > 0) || !st.date) { hintBox.textContent = ''; return; }
    const c = L.candidates({ date: st.date, amount: st.amount }, held(), state.byId)[0];
    const hd = c && held().find((x) => x.id === c.holding);
    hintBox.textContent = hd ? say(hd, c.due, c.kind, 'Looks like') : 'No bond you hold pays this amount around this date.';
  };
  const save = () => {
    if (!(st.amount > 0) || !st.date) {
      const out = sheet().querySelector('.complaint') || h('p', { class: 'complaint', role: 'alert' });
      out.textContent = 'Enter the date and the amount.';
      sheet().querySelector('.body').append(out);
      return;
    }
    const p = { id: edit?.id || uid(), date: st.date, amount: st.amount, narration: st.narration.trim() || null };
    const hd = st.choice && held().find((x) => x.id === st.choice);
    if (hd) {
      const near = L.nearestDue(p, hd, bondOf(hd));
      Object.assign(p, { holding: hd.id, due: near ? near.due : p.date, kind: near ? near.kind : 'interest' });
    } else if (edit?.label) p.label = edit.label; // still the removed bond's, unless another is chosen
    state.store.payments = edit ? state.store.payments.map((x) => (x.id === p.id ? p : x)) : [...state.store.payments, p];
    write();
    done();
  };
  const remove = () => {
    const foot = sheet().querySelector('footer');
    foot.replaceChildren(h('span', { class: 'ask' }, 'Remove this payment?'),
      h('button', { class: 'button quiet', type: 'button', onclick: () => openPayment(edit) }, 'Keep it'),
      h('button', { class: 'button', type: 'button', onclick: () => {
        state.store.payments = state.store.payments.filter((x) => x.id !== edit.id);
        write();
        done();
      } }, 'Remove'));
    foot.querySelector('.button').focus();
  };
  openSheet(edit ? 'A payment you received' : 'Record a payment', [
    h('div', { class: 'row' },
      field('Date', h('input', { type: 'date', max: t, value: st.date, oninput: (e) => { st.date = e.target.value; guess(); } })),
      field('Amount', h('div', { class: 'prefix' }, h('span', {}, '₹'),
        h('input', { type: 'number', min: '0.01', step: '0.01', inputmode: 'decimal', value: st.amount ?? '', oninput: (e) => { st.amount = num(e.target.value); guess(); } })))),
    hintBox,
    field('Bank narration', h('input', { type: 'text', value: st.narration, oninput: (e) => { st.narration = e.target.value; } }), { hint: edit ? null : 'Optional. Paste it from your statement to keep a record.' }),
    field('Bond', sel),
  ], [edit && h('button', { class: 'link quiet', type: 'button', style: 'margin-right:auto', onclick: remove }, 'Remove'),
    h('button', { class: 'button quiet', type: 'button', onclick: () => sheet().close() }, 'Cancel'),
    h('button', { class: 'button', type: 'button', onclick: save }, edit ? 'Save' : 'Record')]);
  // An existing payment says what it was matched to, until the amount or date changes.
  const m = edit && ledger().match.get(edit.id);
  const hd = m && held().find((x) => x.id === m.holding);
  if (hd) hintBox.textContent = say(hd, m.due, m.kind, 'Matched to');
  else if (edit?.label) hintBox.textContent = `From ${edit.label}, which you removed.`;
  else guess();
  if (edit && !hd && !edit.label && matchMedia('(pointer: fine)').matches) sel.focus(); // it was opened to answer "Which bond?"
}

// Many credits at once: paste the lines of a statement, keep the ones that are interest.
function openPaste() {
  const t = today();
  let found = [];
  const list = h('ul', { class: 'plain found', 'aria-live': 'polite' });
  const add = h('button', { class: 'button', type: 'button', disabled: true, onclick: () => {
    const have = new Set(state.store.payments.map((p) => `${p.date}|${p.amount}`));
    for (const f of found) if (!have.has(`${f.date}|${f.amount}`)) state.store.payments.push({ id: uid(), ...f });
    write();
    done();
  } }, 'Add');
  const read = (text) => {
    const have = new Set(state.store.payments.map((p) => `${p.date}|${p.amount}`));
    const lines = text.split(/\n+/).filter((x) => x.trim());
    const interest = lines.map((line) => L.readLine(line, held(), state.byId)).filter((f) => f && L.candidates(f, held(), state.byId).length);
    found = interest.filter((f) => !have.has(`${f.date}|${f.amount}`));
    const already = interest.length - found.length;
    // say what happened to the lines that were not kept, so a paste never just goes quiet
    const note = !lines.length ? null
      : !interest.length ? 'None of these lines is a payment from your bonds.'
        : already ? `${already} ${already === 1 ? 'is' : 'are'} already recorded.` : null;
    list.replaceChildren(...found.map((f) => {
      const c = L.candidates(f, held(), state.byId)[0];
      return h('li', {}, h('span', { class: 'figures' }, L.sayDate(f.date, t, { weekday: false })), money(f.amount), h('span', {}, nameOf(held().find((x) => x.id === c.holding))));
    }), ...(note ? [h('li', { class: 'note' }, note)] : []));
    add.disabled = !found.length;
    add.textContent = found.length ? `Add ${found.length} ${found.length === 1 ? 'payment' : 'payments'}` : 'Add';
  };
  openSheet('Paste from a statement', [
    field('Lines from your bank statement', h('textarea', { placeholder: '12/09/25  NEFT CR-ICIC0099999-CENTRAL DEPOSITORY SERVICES…  3,680.01', oninput: (e) => read(e.target.value) }),
      { hint: 'Paste as many lines as you like; only credits that match a payment from your bonds are kept.' }),
    list,
  ], [h('button', { class: 'button quiet', type: 'button', onclick: () => sheet().close() }, 'Cancel'), add]);
}

// ---------------------------------------------------------------- backup
function backup() {
  const blob = new Blob([JSON.stringify({ app: 'gsecs', version: 1, saved: new Date().toISOString(), ...state.store }, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `gsecs-${today()}.json` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function restore(file) {
  file.text().then((text) => {
    let raw = null;
    try { raw = JSON.parse(text); } catch {}
    const s = L.clean(raw);
    if (!s) {
      openSheet('That file isn’t a backup', h('p', {}, 'Choose a file saved with “Back up” on this site.'),
        h('button', { class: 'button', type: 'button', onclick: () => sheet().close() }, 'OK'));
      return;
    }
    const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    const has = held().length + state.store.payments.length;
    const skipped = raw.holdings.length + raw.payments.length - s.holdings.length - s.payments.length;
    const replace = () => {
      state.store = s;
      write();
      sheet().close();
      if (location.hash.replace(/^#/, '') !== '/' && location.hash !== '') location.hash = '#/';
      else { render(); main().focus(); }
    };
    if (!has && !skipped) { replace(); return; }
    openSheet(has ? 'Replace what’s here with the backup?' : 'Restore the backup?', [
      h('p', {}, `The file has ${n(s.holdings.length, 'bond', 'bonds')} and ${n(s.payments.length, 'payment', 'payments')}`,
        has ? `; this browser has ${n(held().length, 'bond', 'bonds')} and ${n(state.store.payments.length, 'payment', 'payments')}, which restoring replaces.` : '.'),
      skipped ? h('p', { class: 'muted' }, `${n(skipped, 'record', 'records')} in it could not be read and will be left out.`) : null,
    ], [h('button', { class: 'button quiet', type: 'button', onclick: () => sheet().close() }, has ? 'Keep what’s here' : 'Cancel'),
      h('button', { class: 'button', type: 'button', onclick: replace }, has ? 'Replace' : 'Restore')]);
  });
}

// ---------------------------------------------------------------- start
async function boot() {
  state.failed = false;
  render();
  try {
    const r = await fetch('bonds.json');
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    state.bonds = d.bonds;
    state.asof = d.asof;
    for (const b of d.bonds) { b._hay = haystack(b); state.byId[b.id] = b; }
    state.loaded = true;
  } catch {
    state.failed = true;
  }
  render();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  if (a.dataset.action === 'backup') backup();
  if (a.dataset.action === 'restore') document.querySelector('[data-restore]').click();
});
document.querySelector('[data-restore]').addEventListener('change', (e) => { if (e.target.files[0]) restore(e.target.files[0]); e.target.value = ''; });
window.addEventListener('hashchange', () => { render(); main().focus({ preventScroll: true }); window.scrollTo(0, 0); });
document.querySelector('.skip-link').addEventListener('click', (e) => { e.preventDefault(); main().focus(); });
window.addEventListener('storage', (e) => { if (e.key === KEY) { state.store = read(); render(); } });
boot();
