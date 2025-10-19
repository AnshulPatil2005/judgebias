You fill out the form:

Select Case Type → AO – Appeal from Order

Enter Year → e.g., 2018

Select Disposed (Closed)

Type the CAPTCHA shown on the page

You click GO manually.

The website might reject it and show a new CAPTCHA (this happens even with correct input sometimes).

The script will not click anything yet — it just waits in the background.

If you see a new CAPTCHA,

Type that new CAPTCHA on the page,

Click GO again yourself.

When the results table (rows with “View” buttons) finally appears,
→ then press ENTER in the terminal.

## Installation

```bash
pip install playwright pandas
playwright install

Small test (one year, capped rows):

python gujarat_hc_AO_turbo.py --years 2018 --max-per-year 5


Full sweep (2018–2025, all rows):

python gujarat_hc_AO_turbo.py --years 2018-2025 --max-per-year 0


The script creates/appends to:

gujarat_hc_AO_2018_2025_details.csv
