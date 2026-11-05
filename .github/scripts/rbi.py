"""Fetch and parse the RBI press releases behind every record in data/.

Only the formats RBI has used since mid-2020 matter here: the daily job only
ever reads recent releases. The 2012-2020 history was built from older
formats and is frozen.
"""
import datetime as dt
import html
import re
import time
import urllib.parse
import urllib.request

from bs4 import BeautifulSoup

BASE = 'https://rbi.org.in/Scripts/'
LIST_URL = BASE + 'BS_PressreleaseDisplay.aspx'
PR_URL = BASE + 'BS_PressReleaseDisplay.aspx?prid={}'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
MONTHS = {m: i for i, m in enumerate('jan feb mar apr may jun jul aug sep oct nov dec'.split(), 1)}
DATE = r'([A-Za-z]{3,9}\.?\s*\d{1,2}(?:st|nd|rd|th)?\s*,?\s*\d{4})'

_cache = {}


def http(url, form=None):
    key = (url, tuple(sorted(form.items())) if form else None)
    if key not in _cache:
        data = urllib.parse.urlencode(form).encode() if form else None
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, 'Referer': LIST_URL})
                with urllib.request.urlopen(req, timeout=90) as r:
                    _cache[key] = r.read().decode('utf-8', 'replace')
                break
            except OSError:
                if attempt == 3:
                    raise
                time.sleep(5 * (attempt + 1))
        time.sleep(0.4)  # be gentle with rbi.org.in
    return _cache[key]


def norm(s):
    s = html.unescape(s).replace('\xa0', ' ').replace('–', '-').replace('—', '-').replace('’', "'")
    return re.sub(r'\s+', ' ', s).strip()


def parse_date(s):
    """'Aug 03, 2012' / 'August 3,2012' / '3rd August 2012' -> date"""
    s = norm(s or '')
    m = re.search(r'([A-Za-z]{3,9})\.?\s*(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})', s)
    if m and m.group(1)[:3].lower() in MONTHS:
        return dt.date(int(m.group(3)), MONTHS[m.group(1)[:3].lower()], int(m.group(2)))
    m = re.search(r'(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9}),?\s+(\d{4})', s)
    if m and m.group(2)[:3].lower() in MONTHS:
        return dt.date(int(m.group(3)), MONTHS[m.group(2)[:3].lower()], int(m.group(1)))
    return None


def num(s):
    if s is None:
        return None
    s = norm(s)
    s = re.sub(r'(\d)\.\s+(\d)', r'\1.\2', s)                                   # '5,980. 50'
    s = re.sub(r'(?<![\d.])(\d{1,3})\.(\d{3})\.(\d{1,4})(?![\d.])', r'\1\2.\3', s)  # '7.355.00' typo
    if re.fullmatch(r'(?i)(nil|none)', s):
        return 0.0
    m = re.search(r'-?\d[\d,]*\.?\d*', s.replace('`', ''))
    return float(m.group(0).replace(',', '')) if m else None


# ---------------------------------------------------------------- security names
def canon(name, auction_year=None):
    """Any RBI spelling of a dated security -> dict(type, coupon, year, new)."""
    n = re.sub(r'\s+', ' ', name.replace('*', ' ').replace('|', ' ')).strip()
    low = n.lower()
    if re.search(r'frb|floating', low):
        t = 'FRB'
    elif re.search(r'sgrb|green', low):
        t = 'SGrB'
    elif re.search(r'inflation|iib|iigs|indexed', low):
        t = 'IIB'
    else:
        t = 'GS'
    m = re.search(r'(?<![\d.])(\d{1,2}(?:\s*\.\s*\d{1,2})?)\s*(?:%|per\s*cent|percent)', n, re.I)
    coupon = float(m.group(1).replace(' ', '')) if m and t != 'FRB' else None
    years = re.findall(r'(?<!\d)((?:19|20)\d\d)(?!\d)', n)
    year = int(years[-1]) if years else None
    if year is None and auction_year:
        m = re.search(r'(\d{1,2})\s*-?\s*(?:yr|year)', n, re.I)
        year = auction_year + int(m.group(1)) if m else None
    return {'type': t, 'coupon': coupon, 'year': year, 'new': bool(re.search(r'\bnew\b|\(new\)|fresh issue', n, re.I))}


def display(t, coupon, year):
    if t == 'FRB':
        return f'GOI FRB {year}'
    return {'GS': '{:.2f}% GS {}', 'SGrB': '{:.2f}% GOI SGrB {}', 'IIB': '{:.2f}% GOI IIB {}'}[t].format(coupon, year)


NAME_RE = re.compile(r'((?:\d{1,2}(?:\.\d{1,2})?\s*%|\d{1,2}(?:\.\d{1,2})?\s*per\s*cent|GOI\b|GoI\b|NEW\b|New\b)'
                     r'[^%]{0,80}?(?:19|20)\d\d)\*?')
METHOD = r'(uniform|multiple) (?:price|yield)(?:-based)?\s*(?:auction\s*)?(?:method)?'


def method_map(text):
    """'using uniform price method for A and multiple price method for B' -> (global, {key: method})"""
    glob, per = None, {}
    for m in re.finditer(r'(?i)(?:using|be a)\s+((?:uniform|multiple) (?:price|yield).*?)(?:\.\s|\.$|$)', text):
        parts = re.split('(?i)' + METHOD, m.group(1))
        for i in range(1, len(parts), 2):
            seg = parts[i + 1] if i + 1 < len(parts) else ''
            if re.match(r'(?i)\s*for (?:both|all)\b', seg):
                glob = glob or parts[i].lower()
            elif re.match(r'(?i)\s*for\b', seg):
                for n in NAME_RE.finditer(seg):
                    c = canon(n.group(1))
                    per[(c['type'], c['coupon'], c['year'])] = parts[i].lower()
            elif len(parts) == 3 and not NAME_RE.search(seg) and glob is None:
                glob = parts[i].lower()
    return glob, per


# ---------------------------------------------------------------- pages
def listing(year, month):
    """All press releases of a month: [{'date', 'title', 'prid'}], newest first."""
    page = BeautifulSoup(http(LIST_URL), 'lxml')
    form = {i['name']: i.get('value', '') for i in page.find_all('input')
            if i.get('name') in ('__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION')}
    form.update({'__EVENTTARGET': '', '__EVENTARGUMENT': '', 'hdnYear': str(year), 'hdnMonth': str(month),
                 'UsrFontCntr$txtSearch': '', 'UsrFontCntr$btn': ''})
    table = BeautifulSoup(http(LIST_URL, form), 'lxml').find('table', class_='tablebg')
    out, day = [], None
    for tr in table.find_all('tr'):
        head = tr.find('td', class_='tableheader')
        if head:
            day = parse_date(head.get_text(' '))
            continue
        a = tr.find('a', class_='link2')
        m = re.search(r'prid=(\d+)', a.get('href', '')) if a else None
        if m:
            out.append({'date': day, 'title': norm(a.get_text(' ')), 'prid': int(m.group(1))})
    return out


def release(prid):
    """-> (release date, text, tables as lists of rows of cell texts)"""
    tb = BeautifulSoup(http(PR_URL.format(prid)), 'lxml').find('table', class_='tablebg')
    for br in tb.find_all('br'):
        br.replace_with(' | ')
    text = norm(tb.get_text(' '))
    m = re.search(r'Date\s*:\s*([A-Za-z]{3,9}\.? \d{1,2},? \d{4})', text)
    tables = []
    for t in tb.find_all('table'):
        rows = [[norm(c.get_text(' ')) for c in tr.find_all(['td', 'th'], recursive=False)]
                for tr in t.find_all('tr') if tr.find_parent('table') is t]
        tables.append(rows)
    body = re.split(r'\d{4} All Months January', text)[0]   # drop the year/month navigation
    return parse_date(m.group(1)) if m else None, body, tables


def kind(title):
    t = title.lower()
    if re.search(r'state|treasury|t-bill|cash management|\bcmb|switch|conversion|buy.?back|repurchase|underwrit|repo\b|swap|sgb\b|sovereign gold', t):
        return None
    if re.search(r'rate of interest', t) and re.search(r'floating rate|frb', t):
        return 'frb_rate'
    if 'auction result' in t and re.search(r'government stock|green bond|dated secur', t):
        return 'full' if 'full' in t else 'cutoff'
    if re.search(r'^(special )?auction of (government of india|goi) (dated )?securit|^auction of sovereign green', t):
        return 'announcement'
    if re.search(r'holiday|settlement|cancel|postpone|prepone|reschedul', t) and re.search(r'auction|g-sec|securit|holiday', t):
        return 'notice'
    return None


# ---------------------------------------------------------------- auction results
def _results_columns(rows):
    """Find the value-column count from the 'Notified Amount' row and the security names above it."""
    n = start = None
    for i, cells in enumerate(rows):
        for j, c in enumerate(cells):
            if re.search(r'(?i)notified amount', c) and not re.search(r'(?i)underwrit', c):
                n, start = len(cells) - j - 1, i
                break
        if n:
            break
    if not n:
        return None, None, None
    names = None
    for cells in reversed(rows[:start]):
        cand = [c for c in cells if c and not re.fullmatch(r'(?i)auction\s*results?|\(amount in .*\)', c)]
        if len(cand) >= n and all(re.search(r'(?i)(19|20)\d\d|\bnew\b', c) for c in cand[-n:]):
            names = cand[-n:]
            break
    return n, start, names


def results(prid):
    """Auction result release -> (auction date, [per-security dict])"""
    rdate, text, tables = release(prid)
    m = re.search(r'(?i)Date of (?:the )?Auction\s*[:\-]?\s*' + DATE, text) or re.search(r'(?i)held on ' + DATE, text)
    adate = parse_date(m.group(1)) if m else rdate
    out = []
    for rows in tables:
        n, start, names = _results_columns(rows)
        if n and not names:  # header row sits outside this table: take the names from the text
            k = re.search(r'I\.\s*Notified', text)
            seg = text[:k.start()] if k else ''
            seg = seg[seg.lower().rfind('auction result') + 14:] if 'auction result' in seg.lower() else ''
            found = [m.group(1) for m in NAME_RE.finditer(seg)]
            names = found[-n:] if len(found) >= n else None
        if not n or not names:
            continue
        raw = [dict() for _ in range(n)]
        main = last = ''
        for cells in rows[start:]:
            if len(cells) < n:
                continue
            vals, label = cells[-n:], ' '.join(c for c in cells[:-n] if c).strip()
            if label:
                if re.match(r'^\(?[ivx]+\)', label, re.I):
                    key = f'{main} / {label}'
                else:
                    main = key = label
                last = key
            else:
                key = last + ' +'
            for j, v in enumerate(vals):
                raw[j][key] = raw[j][key] + ' | ' + v if key in raw[j] else v
        for name, r in zip(names, raw):
            out.append(dict(name=name, **_interpret(r)))
        if out:
            break
    return adate, out


def _pick(raw, *pats, exclude=None):
    for k, v in raw.items():
        kl = k.lower()
        if all(re.search(p, kl) for p in pats) and not (exclude and re.search(exclude, kl)):
            return v
    return None


def _interpret(raw):
    r = {}
    for k, v in list(raw.items()):  # '(i) Number (ii) Amount' in one cell: '| 26 | ₹ 985.94 Crore'
        if 'number' in k.lower() and 'amount' in k.lower():
            m = re.match(r'[\s|]*(\d+)[\s|]*(?:`|₹|Rs\.?)?\s*([\d,]+\.\d+)', v)
            if m:
                base = re.split(r'\s*(?:\|\s*)?\(i\)|\s/\s', k)[0].strip()
                raw.pop(k)
                raw[base + ' / (i) Number'], raw[base + ' / (ii) Amount'] = m.group(1), m.group(2)
    r['notified'] = num(_pick(raw, r'notified', exclude=r'underwrit|green'))
    cut = ' | '.join(v for k, v in raw.items() if re.search(r'cut.?off|implicit yield', k.lower()))
    cut = re.sub(r'(\d)\.\s+(\d)', r'\1.\2', cut)
    ytm = re.search(r'(?i)(?:YTM|yield)\s*[:=\-]?\s*(\d+\.\d+)\s*%?', cut)
    price = re.search(r'(?<![\d.])(\d{2,3}(?:\.\d{1,4})?)(?![\d.]*\s*%)',
                      re.sub(r'(?i)(YTM|yield)\s*[:=\-]?\s*\d+\.\d+\s*%?', '', cut))
    r['cutoff_yield'] = float(ytm.group(1)) if ytm else None
    r['cutoff_price'] = float(price.group(1)) if price and float(price.group(1)) >= 25 else None
    if r['cutoff_yield'] is None:  # new issues print only the yield: '7.59', '6.48%'
        m = re.search(r'(?<![\d.])(\d{1,2}\.\d{1,4})\s*%?(?![\d.])', cut)
        r['cutoff_yield'] = float(m.group(1)) if m and float(m.group(1)) < 25 else None
    comp = r'^(?!.*non\W*competitive).*competitive'
    r['comp_recv_amt'] = num(_pick(raw, comp + '.*received', 'amount'))
    r['comp_acc_amt'] = num(_pick(raw, comp + '.*accepted', 'amount'))
    r['noncomp_acc_amt'] = num(_pick(raw, r'non\W*competitive.*accepted', 'amount'))
    r['amount_accepted'] = num(_pick(raw, r'amount accepted', exclude=r'underwrit'))
    r['devolvement'] = num(_pick(raw, r'devolvement'))
    wa = re.sub(r'(\d)\.\s+(\d)', r'\1.\2', ' | '.join(v for k, v in raw.items() if 'weighted average' in k.lower()))
    m = re.search(r'(?i)(?:WAY|YTM|yield)\s*[:=\-]?\s*(\d+\.\d+)', wa)
    r['way'] = float(m.group(1)) if m else None
    p = re.search(r'(?<![\d.])(\d{2,3}(?:\.\d{1,4})?)(?![\d.]*\s*%)', re.sub(r'(?i)(WAY|YTM|yield)\s*[:=\-]?\s*\d+\.\d+\s*%?', '', wa))
    r['wap'] = float(p.group(1)) if p and float(p.group(1)) >= 25 else None
    if r['way'] is None and wa:
        m = re.search(r'(?<![\d.])(\d{1,2}\.\d{1,4})\s*%?(?![\d.])', wa)
        r['way'] = float(m.group(1)) if m and float(m.group(1)) < 25 else None
    return r


# ---------------------------------------------------------------- announcements
def announcement(prid):
    """'Auction of Government of India Dated Securities' -> dict(date, rows=[security, repayment, notified, auction, settlement, method])"""
    rdate, text, tables = release(prid)
    out = {'prid': prid, 'date': rdate, 'rows': []}
    for rows in tables:
        hdr = next((i for i, c in enumerate(rows)
                    if any('security' in x.lower() for x in c) and any('notified' in x.lower() for x in c)), None)
        if hdr is None:
            continue
        low = [re.sub(r'\s+', ' ', x.replace('|', ' ')).lower() for x in rows[hdr]]
        col = lambda *ks: next((j for j, x in enumerate(low) if any(k in x for k in ks)), None)
        ci = {'sec': col('security'), 'rep': col('repayment', 'maturity'), 'amt': col('notified'),
              'auc': col('auction date', 'auction'), 'set': col('settlement')}
        shared = {}
        for cells in rows[hdr + 1:]:
            rec = {k: (cells[j] if j is not None and j < len(cells) else None) for k, j in ci.items()}
            if not rec['sec'] or re.match(r'(?i)total', rec['sec']) or not re.search(r'\d{4}', rec['sec']):
                continue
            for k in ('auc', 'set'):  # rowspan'ed: only the first row carries them
                if rec.get(k) and parse_date(rec[k]):
                    shared[k] = rec[k]
                else:
                    rec[k] = shared.get(k)
            out['rows'].append({'security': rec['sec'], 'repayment': parse_date(rec['rep']),
                                'notified': num(rec['amt']), 'auction': parse_date(rec['auc']), 'settlement': parse_date(rec['set'])})
        if out['rows']:
            break
    m = re.search(r'(?i)payment by successful bidders will (?:have to )?be (?:made )?on ' + DATE, text)
    pay = parse_date(m.group(1)) if m else None
    m = re.search(r'(?i)should be submitted in electronic format on .{0,120}? on ' + DATE, text)
    auc = parse_date(m.group(1)) if m else None
    glob, per = method_map(re.split(r'ANNEX|Annex\s*Type of Auction', text)[0])
    if glob is None and not per:
        glob, per = method_map(text)
    for r in out['rows']:
        r['auction'] = r['auction'] or auc
        r['settlement'] = r['settlement'] or pay
        c = canon(r['security'])
        r['method'] = per.get((c['type'], c['coupon'], c['year'])) or glob
    m = re.search(r'(?i)revision is due to ([^.]+)\.', text)
    out['revision_reason'] = m.group(1).strip() if m else None
    out['text'] = text
    return out


def frb_rates(prid):
    """'Rate of interest on … Floating Rate Bond 2033' -> [(bond year, start, end, rate)]"""
    _, text, _ = release(prid)
    out = []
    for m in re.finditer(r'(?i)(?:Floating Rate Bonds?|FRBs?),?\s*(\d{4}).{0,80}?applicable for the half[- ]year\s*'
                         r'(?:beginning\s*)?(?:from\s*)?' + DATE + r'\s*(?:to|-|and ending)\s*' + DATE +
                         r'\s*(?:shall|will|would)?\s*be\s*(\d+\.\d+)\s*(?:per\s*cent|percent|%)', text):
        out.append((int(m.group(1)), parse_date(m.group(2)), parse_date(m.group(3)), float(m.group(4))))
    return out


def notice_effects(prid):
    """Holiday / rescheduling notices -> list of changes to dated-security auctions."""
    rdate, text, _ = release(prid)
    eff = []
    for m in re.finditer(r'(?i)Settlement of the auction of Government of India Dated Securities conducted on ' + DATE +
                         r'[^.]{0,40}? will (?:now )?take place on ' + DATE, text):
        eff.append({'auction': parse_date(m.group(1)), 'settlement': parse_date(m.group(2))})
    for m in re.finditer(r'(?i)auction of Government of India Dated Securities scheduled on ' + DATE +
                         r' will now be conducted on ' + DATE + r'(?:,? with settlement on ' + DATE + ')?', text):
        eff.append({'scheduled': parse_date(m.group(1)), 'auction': parse_date(m.group(2)),
                    'settlement': parse_date(m.group(3)) if m.group(3) else None})
    m = re.search(r'(?i)no transactions and settlements? in Government securities[^.]*? on ' + DATE, text)
    m2 = re.search(r'(?i)postponed to the next working day,? (?:i\.e\.,?\s*)?' + DATE, text)
    if m and m2:
        eff.append({'settlement_from': parse_date(m.group(1)), 'settlement': parse_date(m2.group(1))})
    mentions = bool(re.search(r'(?i)Government of India Dated Securit|Government securities \(primary', text))
    return {'prid': prid, 'date': rdate, 'effects': eff, 'mentions_dated_securities': mentions, 'text': text}
