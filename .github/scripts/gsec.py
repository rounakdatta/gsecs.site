"""Keep data/ a golden dataset of Government of India dated-security auctions.

    gsec.py update [--dry-run]       add new or changed auctions, verify, commit
    gsec.py rebuild 2026-10 [...]    rebuild whole months into .tmp/rebuild (testing)
    gsec.py check                    offline invariants over data/
    gsec.py audit [--sample N]       re-verify random historical records against RBI
    gsec.py selftest                 rebuild the latest auction from RBI; it must match data/ exactly

Every record is parsed deterministically from RBI's own releases, then must
pass every check before it is written:
- each value is found verbatim in its source;
- the cut-off and full-results releases agree;
- for re-issues, the yield recomputed from price, coupon and dates matches;
- the maturity agrees with every earlier record of that bond;
- the dataset-wide invariants hold;
- when AIAPI_HOST and AIAPI_KEY are set, an LLM reading the same releases
  independently must agree on every number and date.
Anything that fails is held back and reported in report.md (the workflow turns
it into a GitHub issue). Nothing unverified is committed.
"""
import argparse
import base64
import calendar
import collections
import datetime as dt
import glob
import json
import os
import random
import re
import subprocess
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import rbi  # noqa: E402

DATA = 'data'
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
TYPE = {'GS': 'Gilt', 'FRB': 'FRB', 'SGrB': 'Sovereign Green Bond', 'IIB': 'Inflation Indexed Bond'}
PR = rbi.PR_URL
D = dt.date.fromisoformat
REPORT, WARN = [], []


class Fail(Exception):
    """A check failed: hold the data back."""


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------- dataset on disk
def load(path=DATA):
    return {os.path.basename(f): json.load(open(f)) for f in sorted(glob.glob(f'{path}/*.json'))}


def serial(fn):
    return int(fn.split('_')[1].split('.')[0])


def dumps(rec):
    def ints(x):
        if isinstance(x, float) and x.is_integer():
            return int(x)
        if isinstance(x, dict):
            return {k: ints(v) for k, v in x.items()}
        if isinstance(x, list):
            return [ints(v) for v in x]
        return x
    return json.dumps(ints(rec), indent=2, ensure_ascii=False) + '\n'


def prids(rec):
    return {int(m) for u in rec['source_urls'] for m in re.findall(r'prid=(\d+)', u)}


# ---------------------------------------------------------------- what RBI has published
def months_back(today, n):
    y, m = today.year, today.month
    for _ in range(n):
        yield y, m
        y, m = (y - 1, 12) if m == 1 else (y, m - 1)


def releases(months):
    """Classify every release in the given (year, month)s."""
    out = collections.defaultdict(list)
    for y, m in months:
        for r in rbi.listing(y, m):
            k = rbi.kind(r['title'])
            if k:
                out[k].append(r)
    return out


def auctions_in(rel):
    """{auction date: {'full': [prid], 'cutoff': [prid]}}; RBI publishes results on the auction day."""
    by = collections.defaultdict(lambda: {'full': [], 'cutoff': []})
    for k in ('full', 'cutoff'):
        for r in rel[k]:
            by[r['date']][k].append(r['prid'])
    return by


def near(rels, lo, hi):
    return [r for r in rels if lo <= r['date'] <= hi]


# ---------------------------------------------------------------- one auction -> records
def frb_coupon(year, settle, rel, bonds):
    """Coupon of FRB <year> for the half-year containing <settle>: (rate, start, end, source url)."""
    for b in bonds.get(('FRB', year), []):  # an earlier tranche in the same coupon period
        cp = b['additional_info'].get('coupon_period')
        if cp and cp[:10] <= settle.isoformat() <= cp[-10:]:
            return b['coupon_rate'], D(cp[:10]), D(cp[-10:]), b['source_urls'][-1], 'first coupon period' in b['additional_info'].get('note', '')
    pool = list(rel.get('frb_rate', []))
    if not pool:  # look back further: RBI fixes each half-year's rate at its start
        pool = releases(months_back(settle, 8)).get('frb_rate', [])
    for r in pool:
        for y, start, end, rate in rbi.frb_rates(r['prid']):
            if y == year and start <= settle <= end:
                return rate, start, end, PR.format(r['prid']), False
    return None, None, None, None, False


def build_auction(adate, ids, anns, notices, rel, bonds):
    """Records for every security issued at the auction on <adate>, in RBI's order."""
    secs, order = {}, []
    for prid in sorted(ids['full']) + sorted(ids['cutoff']):
        rdate, rows = rbi.results(prid)
        if rdate != adate:
            raise Fail(f'{adate}: results release {PR.format(prid)} is for the auction of {rdate}')
        for i, row in enumerate(rows):
            c = rbi.canon(row['name'], adate.year)
            key = (c['type'], c['year'], c['coupon'])
            same = [k for k in secs if k[:2] == key[:2] and (k[2] is None) != (key[2] is None)]
            if c['type'] != 'FRB' and len(same) == 1:  # 'New GS 2036' in one release, '6.94% GS 2036' in the other
                old = same[0]
                if key[2] is not None:  # keep the key that carries the coupon
                    secs[key] = secs.pop(old)
                    order[order.index(old)] = key
                else:
                    key = old
            s = secs.setdefault(key, {'vals': {}, 'names': [], 'new': False, 'prids': []})
            if key not in order:
                order.append(key)
            s['names'].append(row['name'])
            s['new'] |= c['new']
            s['prids'].append(prid)
            for f, v in row.items():
                if f == 'name' or v is None:
                    continue
                old = s['vals'].get(f)
                if old is None:
                    s['vals'][f] = v
                elif abs(old - v) > 1e-6:
                    raise Fail(f'{adate}: {row["name"]}: {f} is {old} in one RBI release and {v} in another')
    if not secs:
        raise Fail(f'{adate}: no securities could be read from the results releases {ids}')

    # notices that changed this auction after it was announced
    announced_for, settle_fix, notes, extra = {adate}, None, [], []
    for n in notices:
        for e in n['effects']:
            if e.get('auction') == adate and e.get('scheduled') and e['scheduled'] != adate:
                announced_for.add(e['scheduled'])
                notes.append(f"Auction moved from {e['scheduled']:%-d %b %Y} to {adate:%-d %b %Y} (RBI notice of {n['date']:%-d %b %Y}).")
                extra.append(PR.format(n['prid']))
            if e.get('auction') == adate and e.get('settlement'):
                settle_fix = (e['settlement'], n)

    # the announcement rows for each security (newest release last: revisions supersede)
    ann_rows = collections.defaultdict(list)
    for a in sorted(anns, key=lambda a: (a['date'], a['prid'])):
        for row in a['rows']:
            if row['auction'] in announced_for:
                c = rbi.canon(row['security'], adate.year)
                ann_rows[(c['type'], c['year'])].append((a, row, c))

    out = []
    for key in order:
        s, (t, year, coupon) = secs[key], key
        v = s['vals']
        dev = v.get('devolvement') or 0
        parts = [v.get('comp_acc_amt'), v.get('noncomp_acc_amt')]
        total = sum(p or 0 for p in parts) + dev if any(p is not None for p in parts) else None
        acc = v.get('amount_accepted')
        if acc is not None:  # the cut-off release's official total; some years it already includes devolvement
            cands = [acc + dev, acc] if dev else [acc]
            issued = min(cands, key=lambda c: abs(c - total)) if total is not None else cands[0]
            if total is not None and abs(issued - total) > 1.0:
                raise Fail(f'{adate}: {s["names"][0]}: accepted total {acc} does not reconcile with the bid components {total}')
        else:
            issued = total
        if not issued:
            log(f'  {adate} {s["names"][0]}: nothing issued (all bids rejected), no record')
            continue
        matches = [x for x in ann_rows.get((t, year), [])
                   if x[2]['coupon'] is None or coupon is None or abs(x[2]['coupon'] - coupon) < 1e-6]
        if not matches:
            raise Fail(f'{adate}: {s["names"][0]}: no RBI announcement lists this security')
        first, latest = matches[0], matches[-1]
        a, row, c = latest
        is_new = s['new'] or c['new']
        if coupon is None and t != 'FRB':
            coupon = v.get('cutoff_yield')
        if t != 'FRB' and is_new and v.get('cutoff_yield') is not None and abs(round(v['cutoff_yield'], 2) - coupon) > 1e-6:
            raise Fail(f'{adate}: new issue {s["names"][0]}: coupon {coupon} differs from cut-off yield {v["cutoff_yield"]}')
        if row['notified'] is not None and v.get('notified') is not None and abs(row['notified'] - v['notified']) > 1e-6:
            raise Fail(f'{adate}: {s["names"][0]}: notified {v["notified"]} in the results but {row["notified"]} in the announcement')

        settle = row['settlement']
        if settle_fix and settle_fix[0] != settle:
            n = settle_fix[1]
            notes.append(f"Settlement moved from {settle:%-d %b} to {settle_fix[0]:%-d %b %Y} (RBI notice of {n['date']:%-d %b %Y}).")
            extra.append(PR.format(n['prid']))
            settle = settle_fix[0]
        for n in notices:  # 'no settlements on F, postponed to S'
            for e in n['effects']:
                if e.get('settlement_from') == settle and e['settlement'] != settle:
                    notes.append(f"Settlement moved from {settle:%-d %b} to {e['settlement']:%-d %b %Y}: "
                                 f"{settle:%-d %b} was declared a holiday after the auction was announced (RBI notice of {n['date']:%-d %b %Y}).")
                    extra.append(PR.format(n['prid']))
                    settle = e['settlement']
        mat = row['repayment']
        if is_new and mat and settle != row['settlement'] and (mat.month, mat.day) == (row['settlement'].month, row['settlement'].day):
            raise Fail(f'{adate}: new issue {s["names"][0]}: settlement moved from {row["settlement"]} to {settle}; RBI may move its '
                       f'maturity ({mat}) too, as it did for 7.37% GOI SGrB 2054 in Jan 2024 - confirm before adding')
        if not settle or not mat:
            raise Fail(f'{adate}: {s["names"][0]}: announcement lacks a settlement or repayment date')
        if mat.year != year:
            raise Fail(f'{adate}: {s["names"][0]}: repayment date {mat} contradicts the year in its name')

        name = display(t, coupon, year)
        earlier = [b for b in bonds.get((t, year), []) if b['security_name'] == name and b['auction_date'] < adate.isoformat()]
        same = [b for b in earlier if b['maturity_date'] == mat.isoformat()]
        if earlier and not same and not is_new:
            raise Fail(f'{adate}: {name}: announcement says repayment {mat}, earlier records say {sorted({b["maturity_date"] for b in earlier})}')
        if is_new and same:
            raise Fail(f'{adate}: {name}: announced as new, but this bond (maturity {mat}) was already issued on {same[0]["issuance_date"]}')
        orig = settle.isoformat() if is_new else (same[0]['additional_info'].get('original_issue_date') if same else None)

        frb = None
        if t == 'FRB':
            if is_new:
                coupon = v.get('cutoff_yield')
                m = re.search(r'(?i)period ending ' + rbi.DATE, a.get('text', ''))
                frb = (coupon, settle, rbi.parse_date(m.group(1)) if m else None, None, True)
            else:
                frb = frb_coupon(year, settle, rel, bonds)
                coupon = frb[0]
            if coupon is None:
                raise Fail(f'{adate}: {name}: no RBI rate release covers the coupon period of {settle}')

        anns_for = sorted({x[0]['prid'] for x in matches}, reverse=True)
        dates = sorted({x[0]['date'] for x in matches})
        rec_notes = list(notes)
        if len(dates) > 1:
            rec_notes.insert(0, f'Announcement of {dates[0]} was revised by RBI on {", ".join(str(d) for d in dates[1:])}.')
        if t == 'FRB':
            rec_notes.append('Floating rate bond: coupon_rate is the rate fixed for the first coupon period at the new issue.' if frb[4] else
                             'Floating rate bond: coupon_rate is the rate RBI set for the coupon period in which this tranche was issued.')

        ai = {'notified_amount_crore': v.get('notified'), 'issue_type': 'New issue' if is_new else 'Re-issue'}
        if orig:
            ai['original_issue_date'] = orig
        if v.get('cutoff_price') is not None:
            ai['cut_off_price'] = v['cutoff_price']
        if v.get('way'):
            ai['weighted_average_yield'] = v['way']
        if v.get('wap'):
            ai['weighted_average_price'] = v['wap']
        for f, k in (('comp_recv_amt', 'competitive_bids_received_crore'), ('comp_acc_amt', 'competitive_bids_accepted_crore'),
                     ('noncomp_acc_amt', 'non_competitive_bids_accepted_crore')):
            if v.get(f) is not None:
                ai[k] = v[f]
        if dev:
            ai['devolvement_on_primary_dealers_crore'] = dev
        if row.get('method'):
            ai['auction_method'] = {'multiple': 'Multiple price', 'uniform': 'Uniform price'}[row['method']]
        if t == 'FRB' and frb[2]:
            ai['coupon_period'] = f'{frb[1]} to {frb[2]}'
        if v.get('notified') and issued > v['notified'] + 0.001:
            ai['additional_amount_retained_crore'] = round(issued - v['notified'], 4)
        if rec_notes:
            ai['note'] = ' '.join(dict.fromkeys(rec_notes))

        src = [PR.format(p) for p in sorted(set(ids['full'])) + sorted(set(ids['cutoff']))]
        src += [PR.format(p) for p in anns_for]
        src += [u for u in dict.fromkeys(extra + ([frb[3]] if frb and frb[3] else [])) if u not in src]
        out.append({
            'security_name': name, 'security_type': TYPE[t], 'security_codes': codes(t, coupon, mat, settle),
            'announcement_date': first[0]['date'].isoformat(), 'auction_date': adate.isoformat(),
            'issuance_date': settle.isoformat(), 'maturity_date': mat.isoformat(),
            'coupon_rate': round(coupon, 2) if coupon is not None else None, 'yield_at_auction': v.get('cutoff_yield'),
            'amount_issued_crore': round(issued, 4), 'interest_payment_frequency': 'semi-annual',
            'source_urls': src, 'additional_info': ai})
    return out


def display(t, coupon, year):
    return rbi.display(t, coupon, year)


def codes(t, coupon, mat, settle):
    """The three patterns the skill defines, applied literally: 690GS65S25, 690GOI65, 690GS2065-GS."""
    if t == 'FRB' or coupon is None:
        return []
    c = str(int(round(coupon * 100)))
    return [f'{c}GS{mat.year % 100:02d}{"JFMAMJJASOND"[settle.month - 1]}{settle.year % 100:02d}',
            f'{c}GOI{mat.year % 100:02d}', f'{c}GS{mat.year}-GS']


# ---------------------------------------------------------------- placing records into files
def place(data, rebuilt):
    """Put the rebuilt auctions' records into their issuance months; keep every other file's position."""
    dates = set(rebuilt)
    keep = {fn: r for fn, r in data.items() if r['auction_date'] not in dates}
    new = [r for recs in rebuilt.values() for r in recs]
    months = {fn[:7] for fn, r in data.items() if r['auction_date'] in dates} | {r['issuance_date'][:7] for r in new}
    writes, deletes = {}, set()
    for month in sorted(months):
        rows = [((r['auction_date'], serial(fn)), r) for fn, r in keep.items() if fn.startswith(month + '_')]
        rows += [((r['auction_date'], i), r) for d, recs in rebuilt.items() for i, r in enumerate(recs)
                 if r['issuance_date'][:7] == month]
        rows.sort(key=lambda x: x[0])
        names = {f'{month}_{i}.json': r for i, (_, r) in enumerate(rows, 1)}
        for fn, r in names.items():
            if data.get(fn) != r:
                writes[fn] = r
        deletes |= {fn for fn in data if fn.startswith(month + '_') and fn not in names}
    return writes, deletes


# ---------------------------------------------------------------- checks
def ytm(price, coupon, settle, mat):
    """Yield (semi-annual, 30/360) that prices the bond at <price> for settlement on <settle>."""
    def d30(a, b):
        d1 = min(a.day, 30)
        d2 = 30 if b.day == 31 and d1 == 30 else b.day
        return (b.year - a.year) * 360 + (b.month - a.month) * 30 + (d2 - d1)

    def back(d, months):
        y, m = divmod(d.month - 1 - months, 12)
        y, m = d.year + y, m + 1
        return dt.date(y, m, min(d.day, calendar.monthrange(y, m)[1]))

    n = 0
    while back(mat, 6 * (n + 1)) > settle:
        n += 1
    nxt = back(mat, 6 * n)
    prev = back(nxt, 6)
    f = d30(settle, nxt) / 180

    def clean(y):
        r = y / 200
        return sum(coupon / 2 / (1 + r) ** (k + f) for k in range(n + 1)) + 100 / (1 + r) ** (n + f) - coupon / 2 * d30(prev, settle) / 180

    lo, hi = 0.0, 30.0
    for _ in range(100):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if clean(mid) > price else (lo, mid)
    return (lo + hi) / 2


def dates_in(text):
    """Every date written in a source text, however RBI spelled it ('Dec.16, 2061', '16 December 2061')."""
    found = {rbi.parse_date(m.group(0)) for m in re.finditer(r'[A-Za-z]{3,9}\.?\s*\d{1,2}(?:st|nd|rd|th)?\s*,?\s*\d{4}', text)}
    found |= {rbi.parse_date(m.group(0)) for m in re.finditer(r'\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9},?\s+\d{4}', text)}
    return found - {None}


def number_in(text, x):
    if x is None:
        return True
    forms = {f'{x:.4f}', f'{x:.3f}', f'{x:.2f}', f'{x:.1f}', f'{x:,.2f}', f'{x:,.3f}', f'{x:,.0f}', f'{x:.0f}', str(x)}
    text = re.sub(r'(\d)\.\s+(\d)', r'\1.\2', text)
    return any(f in text for f in forms)


def verify_sources(rec):
    """Every value of a record must appear verbatim in its own RBI sources."""
    texts = {}
    for u in rec['source_urls']:
        m = re.search(r'prid=(\d+)', u)
        if m:
            d, t, _ = rbi.release(int(m.group(1)))
            texts[u] = (d, t)
    alltext = ' '.join(t for _, t in texts.values())
    results = ' '.join(t for _, t in texts.values() if 'auction result' in t.lower())
    ai, bad = rec['additional_info'], []
    for label, x in (('yield', rec['yield_at_auction']), ('notified', ai['notified_amount_crore']), ('cut-off price', ai.get('cut_off_price'))):
        if not number_in(results, x):
            bad.append(f'{label} {x}')
    if rec['coupon_rate'] is not None and not number_in(alltext, rec['coupon_rate']):
        bad.append(f'coupon {rec["coupon_rate"]}')
    release_dates, written = {d for d, _ in texts.values()}, dates_in(alltext)
    for label in ('auction_date', 'announcement_date', 'issuance_date', 'maturity_date'):
        d = D(rec[label])
        if d not in written and not (label in ('auction_date', 'announcement_date') and d in release_dates):
            bad.append(f'{label} {d}')
    return bad


def invariants(data):
    """Dataset-wide rules; returns a list of violations."""
    bad, months, seen, first = [], collections.defaultdict(list), collections.Counter(), {}
    for fn, r in data.items():
        months[fn[:7]].append(serial(fn))
        if fn[:7] != r['issuance_date'][:7]:
            bad.append(f'{fn}: file month differs from issuance month')
        if not (r['announcement_date'] <= r['auction_date'] <= r['issuance_date'] < r['maturity_date']):
            bad.append(f'{fn}: dates out of order')
        if int(r['maturity_date'][:4]) != int(re.findall(r'(\d{4})\s*$', r['security_name'])[0]):
            bad.append(f'{fn}: maturity year differs from the year in the name')
        if r['yield_at_auction'] is not None and not 0.5 < r['yield_at_auction'] < 15:
            bad.append(f'{fn}: yield out of range')
        if D(r['issuance_date']).weekday() > 4 or D(r['auction_date']).weekday() > 4:
            bad.append(f'{fn}: weekend date')
        ai = r['additional_info']
        comp = [ai.get('competitive_bids_accepted_crore'), ai.get('non_competitive_bids_accepted_crore'), ai.get('devolvement_on_primary_dealers_crore')]
        if comp[0] is not None and abs(sum(c or 0 for c in comp) - r['amount_issued_crore']) > 0.01:
            bad.append(f'{fn}: bid components do not add up to amount_issued_crore')
        if r['security_type'] != 'FRB' and r['security_codes'] != codes(next(k for k, v in TYPE.items() if v == r['security_type']),
                                                                         r['coupon_rate'], D(r['maturity_date']), D(r['issuance_date'])):
            bad.append(f'{fn}: security_codes do not follow the formula')
        seen[(r['auction_date'], r['security_name'], r['maturity_date'])] += 1
        k = (r['security_name'], r['maturity_date'])
        if k not in first or (r['issuance_date'], r['auction_date']) < (first[k]['issuance_date'], first[k]['auction_date']):
            first[k] = r
    for m, ns in months.items():
        if sorted(ns) != list(range(1, len(ns) + 1)):
            bad.append(f'{m}: file serials are not 1..{len(ns)}')
    bad += [f'duplicate record {k}' for k, c in seen.items() if c > 1]
    news = collections.Counter((r['security_name'], r['maturity_date']) for r in data.values() if r['additional_info']['issue_type'] == 'New issue')
    bad += [f'{k}: more than one "New issue" record' for k, c in news.items() if c > 1]
    for k, r in first.items():
        if r['additional_info']['issue_type'] == 'New issue' and r['additional_info'].get('original_issue_date') != r['issuance_date']:
            bad.append(f'{k}: new issue whose original_issue_date is not its issuance date')
    return bad


def price_check(rec):
    ai = rec['additional_info']
    if rec['security_type'] in ('FRB', 'Inflation Indexed Bond') or ai['issue_type'] == 'New issue' or ai.get('cut_off_price') is None:
        return None
    y = ytm(ai['cut_off_price'], rec['coupon_rate'], D(rec['issuance_date']), D(rec['maturity_date']))
    return None if abs(y - rec['yield_at_auction']) <= 0.02 else f'yield {rec["yield_at_auction"]} but price implies {y:.4f}'


# ---------------------------------------------------------------- independent AI reading
def ask_ai(prompt):
    host, key = os.environ.get('AIAPI_HOST', '').strip(), os.environ.get('AIAPI_KEY', '').strip()
    if not host or not key:
        return None
    url = (host if host.startswith('http') else 'https://' + host).rstrip('/') + '/v1/messages'
    body = json.dumps({'model': os.environ.get('AIAPI_MODEL') or 'claude-sonnet-5', 'max_tokens': 4000,
                       'messages': [{'role': 'user', 'content': prompt}]}).encode()
    for _ in range(2):
        try:
            req = urllib.request.Request(url, data=body, headers={'x-api-key': key, 'content-type': 'application/json',
                                                                  'anthropic-version': '2023-06-01', 'user-agent': 'gsecs-pipeline'})
            with urllib.request.urlopen(req, timeout=180) as r:
                reply = json.load(r)
            text = ''.join(b.get('text', '') for b in reply.get('content', []) if b.get('type') == 'text')
            return json.loads(re.search(r'\{.*\}', text, re.S).group(0))
        except Exception as e:  # never print the URL or key: the logs are public
            err = type(e).__name__
    WARN.append(f'AI cross-check unavailable ({err}); deterministic checks only.')
    return None


def ai_check(adate, ids, anns, recs):
    """An LLM reads the same releases; every number and date must agree with the parser's."""
    full = ' '.join(rbi.release(p)[1] for p in ids['full'] + ids['cutoff'])
    ann = ' '.join(re.split(r'ANNEX|Annex\s*Type of Auction', a['text'])[0] for a in anns)
    got = ask_ai(
        'Below are Reserve Bank of India press releases for the Government of India dated-securities auction held on '
        f'{adate:%d %B %Y}: the auction announcement(s) and the auction results. Extract, for every security, the values '
        'as printed. Reply with JSON only:\n'
        '{"securities":[{"name":str,"notified_crore":number,"cut_off_price":number|null,"cut_off_yield":number|null,'
        '"competitive_accepted_crore":number|null,"non_competitive_accepted_crore":number|null,"devolvement_crore":number|null,'
        '"repayment_date":"YYYY-MM-DD","settlement_date":"YYYY-MM-DD"}]}\n'
        'Copy numbers exactly (no commas or currency signs); Nil means 0; use null when a value is not printed. If a release '
        'gives the yield only (new issues), put it in cut_off_yield.\n\nANNOUNCEMENT:\n' + ann[:8000] + '\n\nRESULTS:\n' + full[:12000])
    if got is None:
        return []
    bad = []
    mine = {(rbi.canon(r['security_name'])['type'], int(r['maturity_date'][:4])): r for r in recs}
    for s in got.get('securities', []):
        c = rbi.canon(s.get('name', ''), adate.year)
        r = mine.get((c['type'], c['year']))
        if r is None:
            continue  # e.g. a security with no issuance
        ai = r['additional_info']
        pairs = [('notified', s.get('notified_crore'), ai['notified_amount_crore']),
                 ('cut-off price', s.get('cut_off_price'), ai.get('cut_off_price')),
                 ('cut-off yield', s.get('cut_off_yield'), r['yield_at_auction']),
                 ('competitive accepted', s.get('competitive_accepted_crore'), ai.get('competitive_bids_accepted_crore')),
                 ('non-competitive accepted', s.get('non_competitive_accepted_crore'), ai.get('non_competitive_bids_accepted_crore')),
                 ('devolvement', s.get('devolvement_crore') or 0, ai.get('devolvement_on_primary_dealers_crore', 0)),
                 ('repayment date', s.get('repayment_date'), r['maturity_date'])]
        for label, theirs, ours in pairs:
            if isinstance(ours, (int, float)) or isinstance(theirs, (int, float)):
                if (theirs is None) != (ours is None) or (theirs is not None and abs(float(theirs) - float(ours)) > 1e-6):
                    bad.append(f'{r["security_name"]}: {label} parser={ours} AI={theirs}')
            elif theirs != ours:
                bad.append(f'{r["security_name"]}: {label} parser={ours} AI={theirs}')
        if s.get('settlement_date') and s['settlement_date'] != r['issuance_date'] and 'Settlement moved' not in ai.get('note', '') \
                and 'Auction moved' not in ai.get('note', ''):
            bad.append(f'{r["security_name"]}: settlement parser={r["issuance_date"]} AI={s["settlement_date"]}')
    names = {(rbi.canon(s.get('name', ''), adate.year)['type'], rbi.canon(s.get('name', ''), adate.year)['year']) for s in got.get('securities', [])}
    bad += [f'{r["security_name"]}: the AI reading does not list this security' for k, r in mine.items() if k not in names]
    if not bad:
        log(f'  AI reading agrees on all {len(mine)} securities')
    return bad


def ai_notice_check(n):
    """Does a holiday/rescheduling notice change any dated-securities auction in a way the regexes missed?"""
    got = ask_ai('Does this Reserve Bank of India notice change the date, the settlement date, or the status of any Government of '
                 'India dated-securities auction (not T-bills, not state government securities)? Reply with JSON only: '
                 '{"changes":[{"auction_date":"YYYY-MM-DD","new_auction_date":"YYYY-MM-DD"|null,"new_settlement_date":"YYYY-MM-DD"|null,'
                 '"cancelled":bool}]} using an empty list when it changes nothing.\n\nNOTICE:\n' + n['text'][:8000])
    if got is None:
        return []
    bad = []
    for ch in got.get('changes', []):
        if ch.get('cancelled'):
            continue  # a cancelled auction has no results, so no records
        new_set, new_auc = ch.get('new_settlement_date'), ch.get('new_auction_date')
        if new_set and not any(e.get('settlement') == D(new_set) for e in n['effects']) or \
                new_auc and not any(e.get('auction') == D(new_auc) for e in n['effects']):
            bad.append(f'notice {PR.format(n["prid"])}: the AI reads {ch}; the parser found {n["effects"]}')
    return bad


# ---------------------------------------------------------------- commands
def bond_index(data, skip_dates=()):
    idx = collections.defaultdict(list)
    for r in sorted(data.values(), key=lambda r: r['auction_date']):
        if r['auction_date'] not in skip_dates:
            c = rbi.canon(r['security_name'])
            idx[(c['type'], c['year'])].append(r)
    return idx


def process(dates, by, rel, data):
    """Build and verify the given auctions. Returns ({auction date: records}, problems)."""
    if not dates:
        return {}, []
    lo, hi = min(dates) - dt.timedelta(days=14), max(dates) + dt.timedelta(days=10)
    anns = [rbi.announcement(r['prid']) for r in near(rel['announcement'], lo, max(dates))]
    notices = [n for n in (rbi.notice_effects(r['prid']) for r in near(rel['notice'], lo, hi)) if n['mentions_dated_securities']]
    bonds = bond_index(data, skip_dates={d.isoformat() for d in dates})
    rebuilt, problems = {}, []
    for adate in sorted(dates):
        log(f'auction {adate}')
        try:
            recs = build_auction(adate, by[adate], anns, notices, rel, bonds)
        except Fail as e:
            problems.append(str(e))
            continue
        for r in recs:
            for b in verify_sources(r):
                problems.append(f'{adate} {r["security_name"]}: {b} not found in its RBI sources')
            p = price_check(r)
            if p:
                problems.append(f'{adate} {r["security_name"]}: {p}')
            c = rbi.canon(r['security_name'])
            bonds[(c['type'], c['year'])].append(r)
        mine = [a for a in anns if any(row['auction'] == adate for row in a['rows'])]
        problems += [f'{adate}: {b}' for b in ai_check(adate, by[adate], mine, recs)]
        rebuilt[adate.isoformat()] = recs
    for n in notices:
        problems += ai_notice_check(n)
    return rebuilt, problems


def cmd_update(args):
    today = dt.datetime.now(IST).date() if not args.today else D(args.today)
    data = load()
    rel = releases(months_back(today, 2))
    by = auctions_in(rel)

    # an auction needs (re)building when it has no records yet, or RBI published a results release or a
    # holiday/rescheduling notice about it that its records do not cite yet (revisions, moved settlements)
    todo = set()
    for adate, ids in by.items():
        have = [r for r in data.values() if r['auction_date'] == adate.isoformat()]
        used = set().union(*(prids(r) for r in have)) if have else set()
        fresh_notices = [n['prid'] for n in near(rel['notice'], adate - dt.timedelta(days=7), adate + dt.timedelta(days=7))
                         if n['prid'] not in used and n['date'] >= adate]
        settles = {D(r['issuance_date']) for r in have}
        if not have or not set(ids['full'] + ids['cutoff']) <= used or any(
                e.get('auction') == adate or e.get('settlement_from') in settles
                for p in fresh_notices for e in rbi.notice_effects(p)['effects']):
            todo.add(adate)
    log(f'results in window: {len(by)} auctions; to (re)build: {sorted(map(str, todo)) or "none"}')

    # announced auctions whose results are overdue (an RBI delay is not our error: warn, do not block)
    for r in near(rel['announcement'], today - dt.timedelta(days=12), today):
        for d in {row['auction'] for row in rbi.announcement(r['prid'])['rows'] if row['auction']}:
            if d < today - dt.timedelta(days=1) and d not in by and not any('cancel' in n['title'].lower() for n in rel['notice']):
                WARN.append(f'The auction of {d} was announced on {r["date"]} but RBI has published no results for it yet.')

    rebuilt, problems = process(todo, by, rel, data)
    REPORT.extend(problems)
    if rebuilt:
        writes, deletes = place(data, rebuilt)
        final = {fn: r for fn, r in data.items() if fn not in deletes}
        final.update(writes)
        REPORT.extend(invariants(final))
    else:
        writes, deletes = {}, set()

    if args.audit:
        audit(load(), args.audit, today)
    if REPORT:
        return finish(1)
    if not writes and not deletes:
        log('data is up to date')
        return finish(0)
    for fn in sorted(writes):
        log(f'  write {fn}: {writes[fn]["security_name"]} ({writes[fn]["auction_date"]})')
    for fn in sorted(deletes):
        log(f'  delete {fn}')
    if args.dry_run:
        log('dry run: nothing committed')
        return finish(0)
    added = sorted({r['auction_date'] for r in writes.values()})
    commit(writes, deletes, f'Add RBI auction results of {", ".join(added)}',
           'Built from RBI press releases and verified: values found in their sources, cut-off and full results agree, '
           'yields match prices, dataset invariants hold' + (', independent AI reading agrees.' if not WARN and os.environ.get('AIAPI_KEY') else '.'))
    return finish(0)


def commit(writes, deletes, headline, body):
    """One signed (GitHub-verified) commit through the GraphQL API."""
    repo, token = os.environ['GITHUB_REPOSITORY'], os.environ['GITHUB_TOKEN']
    branch = os.environ.get('GITHUB_REF_NAME', 'main')
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
    changes = {'additions': [{'path': f'{DATA}/{fn}', 'contents': base64.b64encode(dumps(r).encode()).decode()} for fn, r in sorted(writes.items())],
               'deletions': [{'path': f'{DATA}/{fn}'} for fn in sorted(deletes)]}
    q = 'mutation($i: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $i) { commit { oid url } } }'
    variables = {'i': {'branch': {'repositoryNameWithOwner': repo, 'branchName': branch}, 'expectedHeadOid': head,
                       'message': {'headline': headline, 'body': body}, 'fileChanges': changes}}
    req = urllib.request.Request('https://api.github.com/graphql', data=json.dumps({'query': q, 'variables': variables}).encode(),
                                 headers={'Authorization': f'bearer {token}', 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.load(r)
    if out.get('errors'):
        raise SystemExit(f'commit failed: {out["errors"]}')
    log(f'committed {out["data"]["createCommitOnBranch"]["commit"]["url"]}')


def cmd_rebuild(args):
    """Rebuild whole months from RBI (for testing the parser against verified data)."""
    data = load()
    rebuilt_all = {}
    for month in args.months:
        y, m = map(int, month.split('-'))
        nxt = dt.date(y + (m == 12), m % 12 + 1, 1)
        rel = releases(months_back(nxt, 3))
        by = auctions_in(rel)
        dates = {d for d in by if any(r['auction_date'] == d.isoformat() and r['issuance_date'].startswith(month) for r in data.values())}
        rebuilt, problems = process(dates, by, rel, data)
        for p in problems:
            log('PROBLEM ' + p)
        rebuilt_all.update(rebuilt)
    os.makedirs(args.out, exist_ok=True)
    writes, deletes = place({fn: r for fn, r in data.items()}, rebuilt_all)
    for fn, r in writes.items():
        open(os.path.join(args.out, fn), 'w').write(dumps(r))
    log(f'{len(writes)} files differ from data/ (written to {args.out}); {len(deletes)} would be deleted: {sorted(deletes)}')


def audit(data, k, today):
    """Re-verify k random older records against RBI's pages (a rolling audit of the history)."""
    pool = sorted(fn for fn, r in data.items() if r['auction_date'] >= '2020-07-01' and r['auction_date'] < str(today - dt.timedelta(days=60)))
    rng = random.Random(today.isoformat())
    for fn in rng.sample(pool, min(k, len(pool))):
        r = data[fn]
        bad = verify_sources(r)
        p = price_check(r)
        if p:
            bad.append(p)
        log(f'audit {fn}: {"ok" if not bad else bad}')
        WARN.extend(f'Audit of {fn}: {b}' for b in bad)


def cmd_audit(args):
    audit(load(), args.sample, dt.datetime.now(IST).date())
    return finish(1 if WARN else 0)


def cmd_check(args):
    data = load()
    REPORT.extend(invariants(data))
    if not REPORT:
        log(f'{len(data)} records: all invariants hold')
    return finish(1 if REPORT else 0)


def cmd_selftest(args):
    """Rebuild the most recent auction from RBI (with the AI reading when configured); it must reproduce data/ exactly."""
    data = load()
    adate = D(max(r['auction_date'] for r in data.values()))
    rel = releases(months_back(adate, 2))
    rebuilt, problems = process({adate}, auctions_in(rel), rel, data)
    REPORT.extend(problems)
    writes, deletes = place(data, rebuilt)
    if writes or deletes:
        REPORT.append(f'selftest: rebuilding the {adate} auction changes {sorted(writes)}, deletes {sorted(deletes)}')
    if not REPORT:
        log(f'selftest: the {adate} auction rebuilt from RBI matches data/ exactly'
            + ('' if WARN or not os.environ.get('AIAPI_KEY') else ', and the AI reading agrees'))
    return finish(1 if REPORT else 0)


def finish(code):
    if REPORT:
        open('report.md', 'w').write('The daily data update held back its changes because these checks failed:\n\n' +
                                     '\n'.join(f'- {x}' for x in REPORT) + '\n')
        log('\n'.join(['FAILED:'] + REPORT))
    if WARN:
        open('warning.md', 'w').write('\n'.join(f'- {x}' for x in dict.fromkeys(WARN)) + '\n')
        log('\n'.join(['WARNING:'] + list(dict.fromkeys(WARN))))
    return code


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    u = sub.add_parser('update')
    u.add_argument('--dry-run', action='store_true')
    u.add_argument('--today')
    u.add_argument('--audit', type=int, default=int(os.environ.get('AUDIT_SAMPLE', '0')))
    r = sub.add_parser('rebuild')
    r.add_argument('months', nargs='+')
    r.add_argument('--out', default='.tmp/rebuild')
    a = sub.add_parser('audit')
    a.add_argument('--sample', type=int, default=8)
    sub.add_parser('check')
    sub.add_parser('selftest')
    args = p.parse_args()
    sys.exit({'update': cmd_update, 'rebuild': cmd_rebuild, 'audit': cmd_audit, 'check': cmd_check,
              'selftest': cmd_selftest}[args.cmd](args) or 0)


if __name__ == '__main__':
    main()
