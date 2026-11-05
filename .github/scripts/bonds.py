"""data/*.json -> one compact bonds.json for the site: python3 .github/scripts/bonds.py _site/bonds.json"""
import collections
import glob
import json
import sys

KIND = {'Gilt': 'gs', 'FRB': 'frb', 'Sovereign Green Bond': 'sgrb', 'Inflation Indexed Bond': 'iib'}


def build():
    by = collections.defaultdict(list)
    for f in glob.glob('data/*.json'):
        r = json.load(open(f))
        by[(r['security_name'], r['maturity_date'])].append(r)
    bonds = []
    for (name, maturity), rs in by.items():
        rs.sort(key=lambda r: (r['auction_date'], r['issuance_date']))
        kind = KIND[rs[0]['security_type']]
        coupon = name.split('%')[0] if '%' in name else None
        ai = rs[0]['additional_info']
        auctions = []
        for r in rs:
            a = r['additional_info']
            new = a['issue_type'] == 'New issue'
            # what a retail (non-competitive) bidder paid: the weighted average price, else the cut-off
            price = a.get('weighted_average_price') or a.get('cut_off_price') or (100 if new else None)
            auctions.append([r['auction_date'], r['issuance_date'], 1 if new else 0, price, r['yield_at_auction'],
                             r['amount_issued_crore']] + ([r['coupon_rate']] if kind == 'frb' else []))
        # A floating rate bond's rate is reset every six months and data/ holds only the rates of the
        # periods it was auctioned in, so it gets no single coupon here; its auctions keep theirs.
        bonds.append({'id': f'{coupon}-{kind}-{maturity}' if coupon else f'{kind}-{maturity}', 'name': name, 'kind': kind,
                      'coupon': None if kind == 'frb' else rs[-1]['coupon_rate'], 'maturity': maturity,
                      'issued': ai.get('original_issue_date') or rs[0]['issuance_date'], 'auctions': auctions})
    bonds.sort(key=lambda b: (b['maturity'], b['name']))
    asof = max(r['auction_date'] for rs in by.values() for r in rs)
    return {'asof': asof, 'bonds': bonds}


if __name__ == '__main__':
    out = build()
    with open(sys.argv[1], 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'{len(out["bonds"])} bonds, data as of {out["asof"]}')
