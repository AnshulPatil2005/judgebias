# gujarat_hc_AO_turbo.py
# Gujarat High Court AO Scraper (manual submit mode)
# You manually type the CAPTCHA and click GO; script watches for results and scrapes.
# ---------------------------------------------------------

from playwright.sync_api import sync_playwright, TimeoutError as TE
import pandas as pd
import time, os, re, argparse
from pathlib import Path

BASE = "https://hcservices.ecourts.gov.in"
SEARCH_URL = f"{BASE}/ecourtindiaHC/cases/s_casetype.php?court_code=1&dist_cd=1&stateNm=Gujarat&state_cd=17"
CASE_TYPE_LABEL = "AO - APPEAL FROM ORDER"
OUT_CSV = "gujarat_hc_AO_2018_2025_details.csv"

# ---------------- Helper Functions ----------------

def parse_years_arg(arg: str):
    if "-" in arg:
        a, b = arg.split("-", 1)
        return list(range(int(a), int(b) + 1))
    return [int(x) for x in arg.split(",")]

def is_captcha(page) -> bool:
    html = page.content().lower()
    return (
        "captcha" in html
        or page.locator("img[src*='captcha'], input[name*='captcha']").count() > 0
        or page.locator(":text('Captcha')").count() > 0
    )

def wait_user(msg="✅ Type CAPTCHA, click GO, then press ENTER here."):
    print(msg)
    try:
        input()
    except KeyboardInterrupt:
        raise SystemExit

def norm(s: str) -> str:
    s = re.sub(r"\s+", " ", s.strip()).strip(": ")
    s = re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")
    return s

def details_to_dict(page) -> dict:
    """Extract details table from a case detail page."""
    data = {}
    blocks = page.locator("td, th, div, span, p")
    for i in range(min(blocks.count(), 400)):
        t = blocks.nth(i).inner_text().strip()
        if ":" in t:
            k, v = t.split(":", 1)
            k = norm(k)
            v = v.strip()
            if k:
                data[k] = v
    return data

def get_case_rows(page):
    """Extract basic rows (case number, petitioner, respondent, View button)."""
    rows = []
    trs = page.locator("table tr")
    for i in range(trs.count()):
        tr = trs.nth(i)
        view = tr.locator("a:has-text('View'), button:has-text('View')")
        if view.count() == 0:
            continue
        tds = tr.locator("td")
        texts = [tds.nth(j).inner_text().strip() for j in range(min(tds.count(), 6))]
        case_ref   = texts[1] if len(texts) > 1 else ""
        petitioner = texts[2] if len(texts) > 2 else ""
        respondent = texts[3] if len(texts) > 3 else ""
        rows.append({
            "case_ref": case_ref,
            "petitioner": petitioner,
            "respondent": respondent,
            "view_el": view.first
        })
    return rows

def has_results(page) -> bool:
    """Detect if results table with 'View' link is visible."""
    try:
        page.locator("table").first.wait_for(state="visible", timeout=2000)
    except:
        return False
    return page.locator("table tr a:has-text('View'), table tr button:has-text('View')").count() > 0

def click_next(page) -> bool:
    """Go to next page of results."""
    for sel in ['a[rel="next"]','a:has-text("Next")','button:has-text("Next")']:
        if page.locator(sel).count() > 0:
            try:
                with page.expect_navigation(wait_until="domcontentloaded", timeout=10000):
                    page.locator(sel).first.click()
                return True
            except:
                pass
    return False

def append_rows(rows, out_csv=OUT_CSV):
    df = pd.DataFrame(rows)
    header = not os.path.exists(out_csv)
    df.to_csv(out_csv, mode="a", index=False, header=header)

# ---------------- Main Scraper ----------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", default="2018-2025")
    ap.add_argument("--max-per-year", type=int, default=0)
    args = ap.parse_args()

    years = parse_years_arg(args.years)
    max_per = args.max_per_year

    Path(OUT_CSV).touch(exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, args=["--start-maximized"])
        context = browser.new_context(viewport={"width":1366,"height":900})
        page = context.new_page()

        for y in years:
            print(f"\n================ YEAR {y} ================")
            page.goto(SEARCH_URL, wait_until="domcontentloaded")

            # Fill search form
            page.select_option("select[name='case_type']", label=CASE_TYPE_LABEL)
            if page.locator("input[name='year']").count():
                page.fill("input[name='year']", str(y))
            elif page.locator("select[name='year']").count():
                page.select_option("select[name='year']", value=str(y))

            # Select Disposed
            if page.locator("input[type='radio'][value='D']").count():
                page.locator("input[type='radio'][value='D']").check()

            # Wait for you to solve CAPTCHA & click GO
            wait_user("📝 Type CAPTCHA and click GO on the page, then press ENTER here.")

            # Wait for results or retry manually
            while not has_results(page):
                print("⚠️ No results detected yet (maybe CAPTCHA incorrect). Type new CAPTCHA, click GO again, then press ENTER.")
                wait_user()
                if has_results(page):
                    break

            # Process results pages
            total_saved = 0
            while True:
                if is_captcha(page):
                    print("⚠️ CAPTCHA appeared again; solve it and click GO manually.")
                    wait_user()
                    continue

                rows = get_case_rows(page)
                if not rows:
                    break

                results = []
                for r in rows:
                    if max_per and total_saved >= max_per:
                        break
                    # Try to open details
                    try:
                        with page.expect_navigation(wait_until="domcontentloaded", timeout=8000):
                            r["view_el"].click()
                    except TE:
                        pass
                    det = details_to_dict(page)
                    merged = {
                        "case_ref": r["case_ref"],
                        "petitioner": r["petitioner"],
                        "respondent": r["respondent"],
                        **det,
                        "year": y,
                        "case_type": "AO",
                        "status": "Disposed"
                    }
                    results.append(merged)
                    total_saved += 1
                    # Go back
                    try:
                        page.go_back(wait_until="domcontentloaded")
                    except Exception:
                        pass
                    time.sleep(0.4)

                if results:
                    append_rows(results)
                    print(f"✅ Saved {len(results)} records (total {total_saved}) to {OUT_CSV}")

                if max_per and total_saved >= max_per:
                    break
                if not click_next(page):
                    break

        browser.close()

if __name__ == "__main__":
    main()
