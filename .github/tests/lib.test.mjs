// node --test .github/tests/*.test.mjs — the calendar's arithmetic, checked against real bonds and RBI's own figures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../../site/lib.js';

const bond = (coupon, maturity, issued) => ({ coupon, maturity, issued });
const BONDS = {
  gs2052: bond(7.36, '2052-09-12', '2022-09-12'),
  gs2042: bond(8.3, '2042-12-31', '2012-12-31'),
  gs2022: bond(6.84, '2022-12-19', '2016-09-12'),
  gs2029: bond(7.1, '2029-04-18', '2022-04-18'),
  gs2063: bond(7.25, '2063-06-12', '2023-06-12'),
  gs2062: bond(7.4, '2062-09-19', '2022-09-19'),
};
const holding = (id, b, face, date) => ({ id, kind: 'gsec', bond: b, face, date });

test('a bond pays on its maturity day and six months away, even when that day is the 31st', () => {
  assert.deepEqual(L.couponDatesAfter('2042-12-31', '2041-12-31', '2042-12-31'), ['2042-06-30', '2042-12-31']);
  assert.deepEqual(L.couponDatesAfter('2042-12-31', '2042-06-30', '2043-12-31'), ['2042-12-31']); // never past maturity
  assert.equal(L.payDays('2052-09-12'), '12 Mar and 12 Sep');
  assert.equal(L.payDays('2042-12-31'), '30 Jun and 31 Dec');
});

test('₹1 lakh of 7.36% GS 2052 pays ₹3,680 every 12 Mar and 12 Sep, then the principal', () => {
  const p = L.paymentsOf(holding('a', 'gs2052', 100000, '2024-01-02'), BONDS.gs2052);
  assert.deepEqual(p.slice(0, 3).map((x) => [x.date, x.amount]), [['2024-03-12', 3680], ['2024-09-12', 3680], ['2025-03-12', 3680]]);
  assert.deepEqual(p.at(-1), { date: '2052-09-12', on: '2052-09-12', amount: 100000, kind: 'principal' });
  assert.equal(p.filter((x) => x.kind === 'interest').length, 58);
});

test('a new bond pays only the interest since it was first issued on its first coupon date', () => {
  // 6.84% GS 2022 was issued on 12 Sep 2016 but pays on 19 Jun / 19 Dec: the first coupon covers 97 days (30/360).
  const [first, second] = L.paymentsOf(holding('a', 'gs2022', 100000, '2016-09-12'), BONDS.gs2022);
  assert.equal(first.date, '2016-12-19');
  assert.equal(L.days360('2016-09-12', '2016-12-19'), 97);
  assert.ok(Math.abs(first.amount - (3420 * 97) / 180) < 1e-9);
  assert.equal(second.amount, 3420);
});

test('the yield recomputed from an auction price matches what RBI published', () => {
  // RBI, 30 Oct 2026: 6.57% GS 2033 (repayment 17 Aug 2033), cut-off ₹95.71, YTM 7.3818%, settled 2 Nov 2026.
  assert.equal(L.ytm(95.71, 6.57, '2026-11-02', '2033-08-17').toFixed(4), '7.3818');
  // RBI, 3 Aug 2012: 8.19% GS 2020 at ₹99.43 gave 8.2927%.
  assert.equal(L.ytm(99.43, 8.19, '2012-08-06', '2020-01-16').toFixed(4), '8.2927');
});

test('accrued interest runs from the last coupon, or from the first issue if that is later', () => {
  assert.ok(Math.abs(L.accrued(100000, 7.1, '2026-06-18', '2029-04-18') - 7100 * 60 / 360) < 1e-9);
  assert.ok(Math.abs(L.accrued(100000, 6.84, '2016-10-12', '2022-12-19', '2016-09-12') - 6840 * 30 / 360) < 1e-9);
});

test('a gold bond pays 2.5% a year on its issue price, half-yearly from the issue date, for eight years', () => {
  // SGB 2022-23 Series IV: issued 14 Mar 2023 at ₹5,611 a gram.
  const sgb = { id: 's', kind: 'sgb', grams: 4, issuePrice: 5611, issueDate: '2023-03-14', date: '2023-03-14' };
  const p = L.paymentsOf(sgb);
  assert.equal(p[0].date, '2023-09-14');
  assert.ok(Math.abs(p[0].amount - 280.55) < 1e-9);
  assert.deepEqual([p[2].date, p[2].on], ['2024-09-14', '2024-09-16']); // a second Saturday, so Monday
  assert.equal(p.filter((x) => x.kind === 'interest').length, 16);
  assert.deepEqual(p.at(-1), { date: '2031-03-14', on: '2031-03-14', amount: null, kind: 'maturity' });
  assert.ok(Math.abs(L.yearlyIncome(sgb, null, '2026-11-05') - 561.1) < 1e-9);
});

test('a credit is matched to its bond by amount and date, allowing a paisa and a few days', () => {
  const holdings = [holding('a', 'gs2029', 100000, '2023-01-02'), holding('b', 'gs2063', 20000, '2023-07-03')];
  const pays = [
    { id: 1, date: '2025-04-19', amount: 3550 }, // due Fri 18 Apr 2025, Good Friday, so credited on Saturday
    { id: 2, date: '2024-06-12', amount: 724.99 }, // a paisa short
    { id: 3, date: '2024-06-12', amount: 999 }, // not a coupon of anything held
  ];
  const r = L.reconcile(pays, holdings, BONDS);
  assert.deepEqual(r.get(1), { holding: 'a', due: '2025-04-18', kind: 'interest' });
  assert.deepEqual(r.get(2), { holding: 'b', due: '2024-06-12', kind: 'interest' });
  assert.equal(r.get(3), null);
});

test('each due payment is claimed once: a second identical credit is not matched to the same coupon', () => {
  const holdings = [holding('a', 'gs2029', 100000, '2023-01-02')];
  const r = L.reconcile([{ id: 1, date: '2025-04-18', amount: 3550 }, { id: 2, date: '2025-04-19', amount: 3550 }], holdings, BONDS);
  assert.deepEqual(r.get(1), { holding: 'a', due: '2025-04-18', kind: 'interest' });
  assert.equal(r.get(2), null);
});

test('a choice made by hand is kept, even against a better automatic match', () => {
  const holdings = [holding('a', 'gs2029', 100000, '2023-01-02'), holding('b', 'gs2029', 100000, '2023-01-02')];
  const r = L.reconcile([{ id: 1, date: '2025-04-18', amount: 3550, holding: 'b', due: '2025-04-18' }, { id: 2, date: '2025-04-18', amount: 3550 }], holdings, BONDS);
  assert.deepEqual(r.get(1), { holding: 'b', due: '2025-04-18', kind: 'interest' });
  assert.deepEqual(r.get(2), { holding: 'a', due: '2025-04-18', kind: 'interest' });
});

test('a pasted statement line yields its date and the credit that matches a coupon, not the balance', () => {
  const holdings = [holding('a', 'gs2052', 100000, '2024-01-02')];
  const line = '12/09/25 NEFT CR-ICIC0099999-CENTRAL DEPOSITORY SERVICES INDIA LIMITED G-SOMEONE 0000123 12/09/25 3,680.01 1,02,345.67';
  assert.deepEqual(L.readLine(line, holdings, BONDS), { date: '2025-09-12', amount: 3680.01, narration: line });
  assert.equal(L.findDate('Credit on 12 Sep 2025'), '2025-09-12');
  assert.equal(L.readLine('no date here 3,680.01', holdings, BONDS), null);
});

test('amounts are written the Indian way, with paise only when there are paise, never rounded up', () => {
  assert.equal(L.rupees(3550), '₹3,550');
  assert.equal(L.rupees(250000), '₹2,50,000');
  assert.equal(L.rupees(3679.99), '₹3,679.99');
  assert.equal(L.rupees(725.5), '₹725.50');
});

test('dates read the way people say them, with the year only when it is not this year', () => {
  assert.equal(L.sayDate('2026-12-12', '2026-11-05'), 'Sat 12 Dec');
  assert.equal(L.sayDate('2027-03-12', '2026-11-05'), 'Fri 12 Mar 2027');
  assert.equal(L.shiftMonths('2024-01-31', 1), '2024-02-29');
});

test('money due on a bank holiday arrives the next working day, as real credits did', () => {
  assert.equal(L.workingDay('2024-12-28'), '2024-12-30'); // a fourth Saturday: banks shut, paid on Monday
  assert.equal(L.workingDay('2025-06-28'), '2025-06-30'); // a fourth Saturday again
  assert.equal(L.workingDay('2025-12-28'), '2025-12-29'); // a Sunday
  assert.equal(L.workingDay('2025-10-18'), '2025-10-18'); // a third Saturday: banks open, paid that day
  assert.equal(L.workingDay('2026-12-12'), '2026-12-14'); // a second Saturday
  assert.equal(L.workingDay('2028-08-15'), '2028-08-16'); // Independence Day, a Tuesday
  assert.equal(L.workingDay('2026-11-05'), '2026-11-05'); // an ordinary Thursday
});

test('a stored or restored file is cleaned: records that cannot be read are dropped, so they never break the page', () => {
  const s = L.clean({
    holdings: [
      { id: 'a', kind: 'gsec', bond: 'x', face: 1000, date: '2024-01-02' },
      { id: 'b', kind: 'gsec', bond: 'x', face: 1000 }, // no purchase date
      { id: 'c', kind: 'sgb', series: 'S', grams: 1, issuePrice: 5000 }, // no issue date
      { id: 'd', kind: 'sgb', series: 'S', grams: 1, issuePrice: 5000, issueDate: '2023-03-14', date: '2023-03-14' },
      null, 'junk',
    ],
    payments: [{ id: 'p', date: '2024-03-12', amount: 36.8 }, { id: 'q', date: 'yesterday', amount: 5 }, { id: 'r', date: '2024-03-12' }],
  });
  assert.deepEqual(s.holdings.map((h) => h.id), ['a', 'd']);
  assert.deepEqual(s.payments.map((p) => p.id), ['p']);
  assert.equal(L.clean({ holdings: 'x' }), null);
  assert.deepEqual(L.couponDatesAfter('2052-09-12', undefined), []); // and a missing date cannot loop forever
});

test('at maturity the last coupon and the repayment are two payments, each matched on its own', () => {
  const bonds = { m: bond(7.33, '2026-10-30', '2023-10-30') };
  const holdings = [holding('a', 'm', 100000, '2024-01-02')];
  const r = L.reconcile([{ id: 1, date: '2026-10-30', amount: 3665 }, { id: 2, date: '2026-10-30', amount: 100000 }], holdings, bonds);
  assert.deepEqual(r.get(1), { holding: 'a', due: '2026-10-30', kind: 'interest' });
  assert.deepEqual(r.get(2), { holding: 'a', due: '2026-10-30', kind: 'principal' });
  // choosing the bond by hand for the repayment leaves the coupon matched
  const byHand = L.nearestDue({ date: '2026-10-30', amount: 100000 }, holdings[0], bonds.m);
  assert.deepEqual(byHand, { due: '2026-10-30', kind: 'principal' });
  const r2 = L.reconcile([{ id: 1, date: '2026-10-30', amount: 3665 }, { id: 2, date: '2026-10-30', amount: 100000, holding: 'a', ...byHand }], holdings, bonds);
  assert.deepEqual(r2.get(1), { holding: 'a', due: '2026-10-30', kind: 'interest' });
  assert.deepEqual(L.nearestDue({ date: '2026-10-29', amount: 3665 }, holdings[0], bonds.m), { due: '2026-10-30', kind: 'interest' });
});

test('a matured bond no longer counts toward the yearly income', () => {
  assert.equal(L.yearlyIncome(holding('a', 'gs2022', 100000, '2016-09-12'), BONDS.gs2022, '2026-11-05'), 0);
  assert.equal(L.yearlyIncome(holding('a', 'gs2052', 100000, '2024-01-02'), BONDS.gs2052, '2026-11-05'), 7360);
  const early = { kind: 'sgb', grams: 1, issuePrice: 2684, issueDate: '2015-11-26', date: '2015-11-26' };
  assert.equal(L.yearlyIncome(early, null, '2026-11-05'), 0); // redeemed in 2023
});

test('a bond that matures on a holiday repays, with its last coupon, on the working day before', () => {
  const b = bond(5.74, '2026-11-15', '2021-11-15'); // Sunday 15 Nov 2026; Saturday 14th is a second Saturday
  const p = L.paymentsOf(holding('a', 'b', 100000, '2024-01-02'), b);
  assert.deepEqual(p.filter((x) => x.date === '2026-11-15').map((x) => [x.kind, x.on]), [['interest', '2026-11-13'], ['principal', '2026-11-13']]);
  assert.equal(L.previousWorkingDay('2026-11-15'), '2026-11-13');
});

test('the first gold bonds, issued before September 2016, paid 2.75% a year', () => {
  const s = { id: 's', kind: 'sgb', grams: 2, issuePrice: 2684, issueDate: '2015-11-26', date: '2015-11-26' };
  assert.ok(Math.abs(L.paymentsOf(s)[0].amount - 2 * 2684 * 0.01375) < 1e-9);
});

test('a floating rate bond pays on known dates, but each amount waits for the rate RBI sets', () => {
  const frb = { kind: 'frb', coupon: 4.51, maturity: '2034-10-30', issued: '2021-10-30' };
  const p = L.paymentsOf(holding('a', 'f', 100000, '2024-01-02'), frb);
  assert.deepEqual(p.slice(0, 2).map((x) => [x.date, x.amount]), [['2024-04-30', null], ['2024-10-30', null]]);
  assert.equal(p.at(-1).amount, 100000);
  assert.equal(L.yearlyIncome(holding('a', 'f', 100000, '2024-01-02'), frb, '2026-11-05'), null);
});

test('a NEFT reference gives away the day it was sent, so a bare narration still has a date', () => {
  const cdsl = 'NEFT CR-ICIC0099999-CENTRAL DEPOSITORY SERVICES INDIA LIMITED G-A PERSON-';
  assert.equal(L.utrDate(cdsl + 'IN22626200000001'), '2026-09-19'); // 2026, day 262
  assert.equal(L.utrDate(cdsl + 'ICICN22025101800000001'), '2025-10-18'); // 2025-10-18 written out
  assert.equal(L.utrDate(cdsl + 'IN22536300000001'), '2025-12-29'); // day 363 of a common year
  assert.equal(L.utrDate(cdsl + 'IN22636700000001'), null); // no day 367
  assert.equal(L.utrDate(cdsl + 'CMS1234567890'), null); // CMS references carry no date
  const line = cdsl + 'IN22626200000001 1,480.00';
  assert.deepEqual(L.readLine(line, [holding('a', 'gs2062', 40000, '2023-01-02')], BONDS), { date: '2026-09-19', amount: 1480, narration: line });
});

test('a date alone names the bonds that pay around it, nearest first, leaving out what was already received', () => {
  const holdings = [holding('a', 'gs2062', 40000, '2023-01-02'), holding('b', 'gs2052', 100000, '2024-01-02')];
  const near = L.around('2026-09-19', holdings, BONDS);
  assert.deepEqual(near.map((d) => [d.holding, d.due, d.amount]), [['a', '2026-09-19', 1480], ['b', '2026-09-12', 3680]]);
  const left = L.around('2026-09-19', holdings, BONDS, new Set([L.dueKey('b', '2026-09-12')]));
  assert.deepEqual(left.map((d) => d.holding), ['a']);
  assert.deepEqual(L.around('2026-07-01', holdings, BONDS), []);
});

test('the same bank reference is the same credit, whatever the spacing', () => {
  const a = 'NEFT CR-ICIC0099999-CENTRAL DEPOSITORY SERVICES  INDIA  LIMITED     G-A PERSON-IN22626200000001';
  const b = 'NEFT CR-ICIC0099999-CENTRAL DEPOSITORY SERVICES INDIA LIMITED G-A PERSON-IN22626200000001';
  assert.equal(L.referenceOf(a), 'IN22626200000001');
  assert.equal(L.referenceOf(a), L.referenceOf(b));
  assert.equal(L.referenceOf('NEFT Cr-ICIC0099999-CENTRAL DEPOSITORY SERVICES INDIA LIMITED G-A PERSON-CMS1234567890'), 'CMS1234567890');
  assert.equal(L.referenceOf('interest'), null);
});
