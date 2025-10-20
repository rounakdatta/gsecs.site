#!/usr/bin/env python3
"""
Simple RBI Press Release Scraper
Usage: python3 rbi_scraper.py <year> <month>
Example: python3 rbi_scraper.py 2025 8
"""

import sys
import requests
from bs4 import BeautifulSoup


def get_press_releases(year, month):
    """Fetch all press releases for a given year and month"""

    url = "https://rbi.org.in/Scripts/BS_PressreleaseDisplay.aspx"
    session = requests.Session()

    # Step 1: Get the page and extract tokens
    response = session.get(url)
    soup = BeautifulSoup(response.text, 'html.parser')

    tokens = {
        '__VIEWSTATE': soup.find('input', {'name': '__VIEWSTATE'})['value'],
        '__VIEWSTATEGENERATOR': soup.find('input', {'name': '__VIEWSTATEGENERATOR'})['value'],
        '__EVENTVALIDATION': soup.find('input', {'name': '__EVENTVALIDATION'})['value'],
    }

    # Step 2: POST with tokens and month/year
    post_data = {
        '__EVENTTARGET': '',
        '__EVENTARGUMENT': '',
        '__VIEWSTATE': tokens['__VIEWSTATE'],
        '__VIEWSTATEGENERATOR': tokens['__VIEWSTATEGENERATOR'],
        '__EVENTVALIDATION': tokens['__EVENTVALIDATION'],
        'hdnYear': str(year),
        'hdnMonth': str(month),
        'UsrFontCntr$txtSearch': '',
        'UsrFontCntr$btn': '',
    }

    headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': url,
    }

    response = session.post(url, data=post_data, headers=headers)

    # Step 3: Parse and return results
    soup = BeautifulSoup(response.text, 'html.parser')
    releases = []

    for row in soup.find_all('tr'):
        cells = row.find_all('td')
        if len(cells) >= 2:
            date = cells[0].get_text(strip=True)
            title_cell = cells[1]
            title = title_cell.get_text(strip=True)
            link_tag = title_cell.find('a')

            if link_tag and title and date:
                link = link_tag.get('href', '')
                if link.startswith('/'):
                    link = 'https://rbi.org.in' + link

                releases.append({
                    'date': date,
                    'title': title,
                    'link': link
                })

    return releases


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python3 rbi_scraper.py <year> <month>")
        print("Example: python3 rbi_scraper.py 2025 8")
        sys.exit(1)

    year = int(sys.argv[1])
    month = int(sys.argv[2])

    print(f"Fetching press releases for {year}-{month:02d}...\n")

    releases = get_press_releases(year, month)

    print(f"Found {len(releases)} press releases:\n")
    print("=" * 100)

    for i, release in enumerate(releases, 1):
        print(f"{i}. [{release['date']}] {release['title']}")
        print(f"   {release['link']}")
        print()
