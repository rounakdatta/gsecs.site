// The arithmetic behind the calendar. No DOM here, so every rule below is unit-tested in node.
// Dates are ISO strings ('2026-12-19') throughout; they compare correctly as strings.

const pad = (n) => String(n).padStart(2, '0');
const toIso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const parts = (iso) => iso.split('-').map(Number);
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const utc = (iso) => Date.UTC(...parts(iso).map((v, i) => (i === 1 ? v - 1 : v)));

export const DAY = 86400000;
export const addDays = (iso, n) => new Date(utc(iso) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / DAY);

// Shift by whole months from an anchor, keeping the anchor's day where the month has it.
// Coupon dates must always be computed from the maturity date itself, never step by step:
// a bond maturing on 31 Dec pays on 30 Jun and 31 Dec, and stepping back from 30 Jun would
// wrongly land on 30 Dec.
export function shiftMonths(iso, n) {
  const [y, m, d] = parts(iso);
  const k = y * 12 + (m - 1) + n;
  const yy = Math.floor(k / 12);
  const mm = (k % 12) + 1;
  return toIso(yy, mm, Math.min(d, daysIn(yy, mm)));
}

// Government securities pay half-yearly on the maturity date's day and month, and six months away.
export function couponDatesAfter(maturity, after, upto = maturity) {
  const out = [];
  for (let k = 0; ; k++) {
    const d = shiftMonths(maturity, -6 * k);
    if (d <= after) break;
    if (d <= upto) out.push(d);
  }
  return out.reverse();
}

export const previousCoupon = (maturity, onOrBefore) => {
  for (let k = 0; ; k++) {
    const d = shiftMonths(maturity, -6 * k);
    if (d <= onOrBefore) return d;
  }
};

// 30/360, the convention RBI uses for accrued interest on dated securities.
export function days360(a, b) {
  const [y1, m1, d1x] = parts(a);
  const [y2, m2, d2x] = parts(b);
  const d1 = Math.min(d1x, 30);
  const d2 = d2x === 31 && d1 === 30 ? 30 : d2x;
  return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
}

// Interest bought along with the bond: from the last coupon (or the first issue, if later) to settlement.
export function accrued(face, coupon, settle, maturity, issued) {
  let last = previousCoupon(maturity, settle);
  if (issued && issued > last) last = issued;
  return (face * coupon) / 100 * days360(last, settle) / 360;
}

// Yield to maturity (% a year, compounded half-yearly) that prices the bond at `price` per ₹100.
export function ytm(price, coupon, settle, maturity) {
  const next = couponDatesAfter(maturity, settle)[0];
  if (!next) return null;
  const n = couponDatesAfter(maturity, settle).length - 1;
  const prev = shiftMonths(next, -6);
  const f = days360(settle, next) / 180;
  const clean = (y) => {
    const r = y / 200;
    let pv = 100 / (1 + r) ** (n + f);
    for (let k = 0; k <= n; k++) pv += coupon / 2 / (1 + r) ** (k + f);
    return pv - (coupon / 2) * days360(prev, settle) / 180;
  };
  let lo = -5;
  let hi = 40;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (clean(mid) > price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Banks in Mumbai, where RBI pays from, shut on Sundays, the second and fourth Saturdays and a few
// fixed-date holidays; money due on one of those arrives the next working day. Holidays that move
// with the moon (Holi, Diwali, Eid…) are not known here, so on those the money comes a day later.
const SHUT = new Set(['01-26', '04-14', '05-01', '08-15', '10-02', '12-25']);
export function workingDay(iso) {
  let d = iso;
  for (;;) {
    const day = parts(d)[2];
    const wd = new Date(utc(d)).getUTCDay();
    const offSaturday = wd === 6 && ((day > 7 && day <= 14) || (day > 21 && day <= 28));
    if (wd !== 0 && !offSaturday && !SHUT.has(d.slice(5))) return d;
    d = addDays(d, 1);
  }
}

// Every payment a holding makes after it was bought: interest, and the principal at maturity.
// `date` is the day it falls due (and what a payment is matched against); `on` is the working day
// the money actually arrives.
export function paymentsOf(h, bond) {
  if (h.kind === 'sgb') {
    const per = h.grams * h.issuePrice * 0.0125; // 2.5% a year on the issue price, half-yearly
    const out = [];
    for (let k = 1; k <= 16; k++) {
      const date = shiftMonths(h.issueDate, 6 * k);
      if (date > h.date) out.push({ date, on: workingDay(date), amount: per, kind: 'interest' });
    }
    const end = shiftMonths(h.issueDate, 96);
    out.push({ date: end, on: workingDay(end), amount: null, kind: 'maturity' });
    return out;
  }
  if (!bond) return [];
  const half = (h.face * bond.coupon) / 200;
  const out = couponDatesAfter(bond.maturity, h.date).map((date) => {
    // A new bond's first period is usually short (it is issued between two coupon dates);
    // whoever holds it on that first date gets only the interest since the first issue.
    const prev = shiftMonths(date, -6);
    const share = bond.issued && bond.issued > prev ? days360(bond.issued, date) / 180 : 1;
    return { date, on: workingDay(date), amount: half * share, kind: 'interest' };
  });
  out.push({ date: bond.maturity, on: workingDay(bond.maturity), amount: h.face, kind: 'principal' });
  return out;
}

export const yearlyIncome = (h, bond) =>
  h.kind === 'sgb' ? h.grams * h.issuePrice * 0.025 : bond && bond.maturity > h.date ? (h.face * bond.coupon) / 100 : 0;

// Match money that arrived to the payments that were due. The bank narration never names the
// bond (CDSL credits read "…CENTRAL DEPOSITORY SERVICES INDIA LIMITED G-<NAME>…"), but the
// amount and the date do: each holding pays a fixed amount on two fixed dates a year.
const AMOUNT_SLACK = (x) => Math.max(1, x * 0.002); // CDSL credits sometimes differ by a paisa
const EARLY = 3; // days a credit may arrive before the due date
const LATE = 10; // and after it (weekends, holidays)

export function candidates(payment, holdings, bonds) {
  const out = [];
  for (const h of holdings) {
    for (const due of paymentsOf(h, bonds[h.bond])) {
      if (due.amount == null) continue;
      const lag = daysBetween(due.date, payment.date);
      const diff = Math.abs(due.amount - payment.amount);
      if (lag >= -EARLY && lag <= LATE && diff <= AMOUNT_SLACK(due.amount)) {
        out.push({ holding: h.id, due: due.date, kind: due.kind, score: diff * 10 + Math.abs(lag) });
      }
    }
  }
  return out.sort((a, b) => a.score - b.score || a.due.localeCompare(b.due));
}

// Each due payment can be claimed once. Payments the person matched by hand keep their choice.
export function reconcile(payments, holdings, bonds) {
  const taken = new Set();
  const result = new Map();
  for (const p of payments) {
    if (p.holding && p.due) {
      taken.add(`${p.holding}|${p.due}`);
      result.set(p.id, { holding: p.holding, due: p.due });
    }
  }
  const open = payments.filter((p) => !result.has(p.id)).sort((a, b) => a.date.localeCompare(b.date));
  for (const p of open) {
    const c = candidates(p, holdings, bonds).find((x) => !taken.has(`${x.holding}|${x.due}`));
    if (c) {
      taken.add(`${c.holding}|${c.due}`);
      result.set(p.id, { holding: c.holding, due: c.due });
    } else result.set(p.id, null);
  }
  return result;
}

// ---------------------------------------------------------------- reading a bank statement
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function findDate(text) {
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return toIso(+m[1], +m[2], +m[3]);
  m = text.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/); // Indian banks write day first
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (+m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= daysIn(y, +m[2])) return toIso(y, +m[2], +m[1]);
  }
  m = text.match(/\b(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s,-]+(\d{2}|\d{4})\b/);
  if (m && MONTHS.includes(m[2].toLowerCase())) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return toIso(y, MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  }
  return null;
}

export function findAmounts(text) {
  return [...text.matchAll(/(?:₹|Rs\.?|INR)?\s?(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{2})(?!\d)/g)].map((m) =>
    Number(m[1].replace(/,/g, '')),
  );
}

// One pasted statement line -> {date, amount, narration}. A statement line often carries a
// withdrawal, a deposit and a balance; the amount that matches a due payment wins.
export function readLine(line, holdings, bonds) {
  const date = findDate(line);
  const amounts = findAmounts(line);
  if (!date || !amounts.length) return null;
  const best = amounts
    .map((amount) => ({ amount, c: candidates({ date, amount }, holdings, bonds)[0] }))
    .sort((a, b) => (a.c ? a.c.score : 1e9) - (b.c ? b.c.score : 1e9))[0];
  const narration = line.replace(/\s+/g, ' ').trim();
  return { date, amount: best.c ? best.amount : amounts[0], narration };
}

// ---------------------------------------------------------------- words and numbers
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Paise only when there are paise: ₹3,905 and ₹3,649.99. Never rounded up across a rupee.
export function rupees(x) {
  const paise = Math.round(x * 100);
  return '₹' + (paise % 100 === 0 ? inr0.format(paise / 100) : inr2.format(paise / 100));
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthName = (m) => MON[m - 1];

// "Sat 12 Dec", with the year only when it is not this year.
export function sayDate(iso, today, { weekday = true } = {}) {
  const [y, m, d] = parts(iso);
  const dow = DOW[new Date(utc(iso)).getUTCDay()];
  const year = today && today.slice(0, 4) === String(y) ? '' : ` ${y}`;
  return `${weekday ? dow + ' ' : ''}${d} ${MON[m - 1]}${year}`;
}

export const sayMonth = (iso) => `${MON[parts(iso)[1] - 1]} ${parts(iso)[0]}`;

export const percent = (x, digits = 2) => `${x.toFixed(digits)}%`;

// "12 Mar and 12 Sep" — the two dates a government bond pays on, earlier in the year first.
export function payDays(maturity) {
  const a = shiftMonths(maturity, -6);
  const [, m1, d1] = parts(maturity);
  const [, m2, d2] = parts(a);
  const both = [[m1, d1], [m2, d2]].sort((x, y) => x[0] - y[0]);
  return both.map(([m, d]) => `${d} ${MON[m - 1]}`).join(' and ');
}

export const todayIso = () => {
  const now = new Date();
  return toIso(now.getFullYear(), now.getMonth() + 1, now.getDate());
};
