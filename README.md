# hc-scraper

Playwright-based scrapers for Allahabad High Court case status results. Scripts open a Chromium browser,
require manual CAPTCHA input, and download PDFs plus case metadata where supported.

**Setup**
- Install dependencies: `npm install`
- Install Playwright browser: `npx playwright install chromium`

**Scripts**
- `v4.js`: latest; uses `CASE_YEAR` and optional `CASE_TYPE`; saves PDFs and Excel to `downloads/<YEAR>/`; processes up to 50 cases.
- `v3.js`: similar to v4; Excel includes `viewButtonIndex`; saves to `downloads/<YEAR>/`; processes up to 50 cases.
- `v2.js`: older; year is hard-coded to 2018; view selector uses `.someclass` placeholder; saves Excel and PDFs in repo root.
- `scrape_allahabad.js`: earliest; no Excel export; PDFs saved in repo root.

**Run**
```powershell
# v4 (recommended)
$env:CASE_YEAR="2018"; $env:CASE_TYPE="A227(MATTERS)"; node v4.js

# v3
$env:CASE_YEAR="2018"; $env:CASE_TYPE="A227(MATTERS)"; node v3.js

# v2
node v2.js

# legacy
node scrape_allahabad.js
```

**Configuration**
- `CASE_YEAR`: drives the year input and output folder for v3/v4 (default: 2018).
- `CASE_TYPE`: text or regex fragment for matching case type in v3/v4; leave blank to pick the first usable option.
- For v2 and `scrape_allahabad.js`, edit the script if you need a different year or case type.

**Outputs**
- v4: `downloads/<YEAR>/case_details_<YEAR>.xlsx` and PDFs like `downloads/<YEAR>/view_1_pdf_1.pdf`.
- v3: `downloads/<YEAR>/case_details_<YEAR>.xlsx` (includes `viewButtonIndex`) and PDFs in the same folder.
- v2: `case_details.xlsx` (or `case_details_partial.xlsx` on interrupt) and PDFs in repo root.
- `scrape_allahabad.js`: PDFs only in repo root.

**Notes**
- You must solve the CAPTCHA and click Go; the script waits for results.
- The browser stays open after completion for inspection; close it manually when done.
- If the site layout changes, update selectors in the script you are using.
