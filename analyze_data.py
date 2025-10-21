#!/usr/bin/env python3
"""
Analyze government securities data and generate statistics and visualizations
"""

import json
import glob
from pathlib import Path
from datetime import datetime
from collections import defaultdict
import statistics

def load_all_data():
    """Load all JSON files from the data directory"""
    data_files = glob.glob('data/*.json')
    securities = []

    for file_path in data_files:
        try:
            with open(file_path, 'r') as f:
                data = json.load(f)
                securities.append(data)
        except Exception as e:
            print(f"Error reading {file_path}: {e}")

    return securities

def analyze_data(securities):
    """Analyze the securities data and generate statistics"""

    stats = {
        'total_securities': len(securities),
        'total_files': len(glob.glob('data/*.json')),
        'by_month': defaultdict(int),
        'by_security_type': defaultdict(int),
        'total_amount_issued': 0,
        'coupon_rates': [],
        'yields': [],
        'amount_by_month': defaultdict(float),
        'securities_by_year': defaultdict(list),
    }

    for sec in securities:
        # Count by month
        if 'auction_date' in sec and sec['auction_date']:
            month = sec['auction_date'][:7]  # YYYY-MM
            stats['by_month'][month] += 1
            stats['amount_by_month'][month] += sec.get('amount_issued_crore', 0)

        # Count by security type
        sec_type = sec.get('security_type', 'Unknown')
        stats['by_security_type'][sec_type] += 1

        # Total amount issued
        amount = sec.get('amount_issued_crore', 0)
        stats['total_amount_issued'] += amount

        # Coupon rates and yields
        if 'coupon_rate' in sec and sec['coupon_rate']:
            stats['coupon_rates'].append(sec['coupon_rate'])
        if 'yield_at_auction' in sec and sec['yield_at_auction']:
            stats['yields'].append(sec['yield_at_auction'])

        # Group by year
        if 'auction_date' in sec and sec['auction_date']:
            year = sec['auction_date'][:4]
            stats['securities_by_year'][year].append(sec)

    return stats

def print_statistics(stats):
    """Print formatted statistics"""

    print("=" * 80)
    print("GOVERNMENT SECURITIES DATA ANALYSIS")
    print("=" * 80)
    print()

    print(f"📊 OVERVIEW")
    print(f"  Total JSON files: {stats['total_files']}")
    print(f"  Total securities: {stats['total_securities']}")
    print(f"  Total amount issued: ₹{stats['total_amount_issued']:,.0f} crore")
    print()

    print(f"📈 BY SECURITY TYPE")
    for sec_type, count in sorted(stats['by_security_type'].items()):
        print(f"  {sec_type}: {count}")
    print()

    print(f"📅 MONTHLY BREAKDOWN (2025)")
    for month in sorted(stats['by_month'].keys()):
        count = stats['by_month'][month]
        amount = stats['amount_by_month'][month]
        print(f"  {month}: {count} securities, ₹{amount:,.0f} crore")
    print()

    if stats['coupon_rates']:
        print(f"💰 COUPON RATES")
        print(f"  Min: {min(stats['coupon_rates']):.2f}%")
        print(f"  Max: {max(stats['coupon_rates']):.2f}%")
        print(f"  Avg: {statistics.mean(stats['coupon_rates']):.2f}%")
        print(f"  Median: {statistics.median(stats['coupon_rates']):.2f}%")
        print()

    if stats['yields']:
        print(f"📊 YIELDS AT AUCTION")
        print(f"  Min: {min(stats['yields']):.4f}%")
        print(f"  Max: {max(stats['yields']):.4f}%")
        print(f"  Avg: {statistics.mean(stats['yields']):.4f}%")
        print(f"  Median: {statistics.median(stats['yields']):.4f}%")
        print()

    print(f"📆 BY YEAR")
    for year in sorted(stats['securities_by_year'].keys()):
        count = len(stats['securities_by_year'][year])
        total_amount = sum(s.get('amount_issued_crore', 0) for s in stats['securities_by_year'][year])
        print(f"  {year}: {count} securities, ₹{total_amount:,.0f} crore")
    print()

def create_visualizations(stats):
    """Create ASCII-based visualizations"""

    print("=" * 80)
    print("VISUALIZATIONS")
    print("=" * 80)
    print()

    # Monthly issuance bar chart
    print("📊 MONTHLY ISSUANCE VOLUMES (in ₹ crore)")
    print()

    max_amount = max(stats['amount_by_month'].values()) if stats['amount_by_month'] else 1

    for month in sorted(stats['amount_by_month'].keys()):
        amount = stats['amount_by_month'][month]
        bar_length = int((amount / max_amount) * 50)
        bar = '█' * bar_length
        print(f"  {month}  {bar} ₹{amount:>8,.0f}")
    print()

    # Monthly count chart
    print("📊 MONTHLY SECURITY COUNT")
    print()

    max_count = max(stats['by_month'].values()) if stats['by_month'] else 1

    for month in sorted(stats['by_month'].keys()):
        count = stats['by_month'][month]
        bar_length = int((count / max_count) * 50)
        bar = '█' * bar_length
        print(f"  {month}  {bar} {count:>3}")
    print()

    # Coupon rate distribution
    if stats['coupon_rates']:
        print("📊 COUPON RATE DISTRIBUTION")
        print()

        # Create histogram buckets
        min_rate = min(stats['coupon_rates'])
        max_rate = max(stats['coupon_rates'])
        bucket_size = 0.25
        buckets = defaultdict(int)

        for rate in stats['coupon_rates']:
            bucket = round(rate / bucket_size) * bucket_size
            buckets[bucket] += 1

        max_bucket_count = max(buckets.values()) if buckets else 1

        for bucket in sorted(buckets.keys()):
            count = buckets[bucket]
            bar_length = int((count / max_bucket_count) * 40)
            bar = '█' * bar_length
            print(f"  {bucket:5.2f}%  {bar} ({count})")
        print()

def main():
    print("Loading data...")
    securities = load_all_data()

    print("Analyzing data...")
    stats = analyze_data(securities)

    print_statistics(stats)
    create_visualizations(stats)

    print("=" * 80)
    print("Analysis complete!")
    print("=" * 80)

if __name__ == '__main__':
    main()
