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
  assert.ok(Math.abs(L.yearlyIncome(sgb) - 561.1) < 1e-9);
});

test('a credit is matched to its bond by amount and date, allowing a paisa and a few days', () => {
  const holdings = [holding('a', 'gs2029', 100000, '2023-01-02'), holding('b', 'gs2063', 20000, '2023-07-03')];
  const pays = [
    { id: 1, date: '2025-04-19', amount: 3550 }, // due Fri 18 Apr 2025, Good Friday, so credited on Saturday
    { id: 2, date: '2024-06-12', amount: 724.99 }, // a paisa short
    { id: 3, date: '2024-06-12', amount: 999 }, // not a coupon of anything held
  ];
  const r = L.reconcile(pays, holdings, BONDS);
  assert.deepEqual(r.get(1), { holding: 'a', due: '2025-04-18' });
  assert.deepEqual(r.get(2), { holding: 'b', due: '2024-06-12' });
  assert.equal(r.get(3), null);
});

test('each due payment is claimed once: a second identical credit is not matched to the same coupon', () => {
  const holdings = [holding('a', 'gs2029', 100000, '2023-01-02')];
  const r = L.reconcile([{ id: 1, date: '2025-04-18', amount: 3550 }, { id: 2, date: '2025-04-19', amount: 3550 }], holdings, BONDS);
  assert.deepEqual(r.get(1), { holding: 'a', due: '2025-04-18' });
  assert.equal(r.get(2), null);
});

test('a choice made by hand is kept, even against a better automatic match', () => {
  const holdings = [holding('a', 'gs2029', 100000, '2023-01-02'), holding('b', 'gs2029', 100000, '2023-01-02')];
  const r = L.reconcile([{ id: 1, date: '2025-04-18', amount: 3550, holding: 'b', due: '2025-04-18' }, { id: 2, date: '2025-04-18', amount: 3550 }], holdings, BONDS);
  assert.deepEqual(r.get(1), { holding: 'b', due: '2025-04-18' });
  assert.deepEqual(r.get(2), { holding: 'a', due: '2025-04-18' });
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
