# gujarat_hc_AO_resilient.py
# Gujarat High Court AO Scraper (manual CAPTCHA; per-row save; new-tab safe; resumable)

from playwright.sync_api import sync_playwright, TimeoutError as TE
import pandas as pd
import time, os, re, argparse, random, sys
from pathlib import Path

BASE = "https://hcservices.ecourts.gov.in"
SEARCH_URL = f"{BASE}/ecourtindiaHC/cases/s_casetype.php?court_code=1&dist_cd=1&stateNm=Gujarat&state_cd=17"
CASE_TYPE_LABEL = "AO - APPEAL FROM ORDER"
OUT_CSV = "gujarat_hc_AO_2018_2025_details.csv"

# ---------------- Utilities ----------------

def parse_years_arg(arg: str):
    if "-" in arg:
        a, b = arg.split("-", 1)
        return list(range(int(a), int(b) + 1))
    return [int(x) for x in arg.split(",")]

def wait_user(msg="📝 Type CAPTCHA and click GO on the page, then press ENTER here."):
    print(msg)
    try:
        input()
    except KeyboardInterrupt:
        raise SystemExit

def norm(s: str) -> str:
    s = re.sub(r"\s+", " ", s.strip()).strip(": ")
    s = re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")
    return s

def stable_sleep(a=0.25, b=0.75):
    time.sleep(random.uniform(a, b))

def is_captcha(page) -> bool:
    try:
        if page.locator("img[src*='captcha']").first.count() > 0:
            return True
        if page.locator("input[name*='captcha' i']").first.count() > 0:
            return True
        if page.get_by_text(re.compile(r"captcha", re.I)).count() > 0:
            return True
    except Exception:
        return False
    return False

def details_to_dict(page) -> dict:
    data = {}
    blocks = page.locator("td, th, div, span, p")
    n = min(blocks.count(), 600)
    for i in range(n):
        try:
            t = blocks.nth(i).inner_text().strip()
        except Exception:
            continue
        if ":" not in t:
            continue
        k, v = t.split(":", 1)
        k = norm(k)
        v = v.strip()
        if k and v and k not in data:
            data[k] = v
    return data

def detect_results(page, timeout=6000) -> bool:
    try:
        page.locator("table").first.wait_for(state="visible", timeout=timeout)
        return page.locator("table tr a:has-text('View'), table tr button:has-text('View')").count() > 0
    except Exception:
        return False

def get_case_rows(page):
    rows = []
    v_rows = page.locator("table tr").filter(has=page.locator("a:has-text('View'), button:has-text('View')"))
    cnt = v_rows.count()
    for i in range(cnt):
        tr = v_rows.nth(i)
        tds = tr.locator("td")
        td_count = tds.count()
        cells = []
        for j in range(min(td_count, 8)):
            try:
                cells.append(tds.nth(j).inner_text().strip())
            except Exception:
                cells.append("")
        case_ref   = cells[1] if len(cells) > 1 else ""
        petitioner = cells[2] if len(cells) > 2 else ""
        respondent = cells[3] if len(cells) > 3 else ""
        view_el = tr.locator("a:has-text('View'), button:has-text('View')").first
        rows.append({
            "case_ref": case_ref,
            "petitioner": petitioner,
            "respondent": respondent,
            "view_el": view_el
        })
    return rows

def click_next(page) -> bool:
    selectors = ['a[rel="next"]','a:has-text("Next")','button:has-text("Next")','input[type=button][value="Next" i]']
    before_sig = ""
    try:
        before_sig = page.locator("table").first.inner_text(timeout=2000)
    except Exception:
        pass
    for sel in selectors:
        loc = page.locator(sel).first
        if loc.count() == 0 or not loc.is_enabled():
            continue
        try:
            with page.expect_navigation(wait_until="domcontentloaded", timeout=5000):
                loc.click()
            return True
        except TE:
            try:
                loc.click()
                stable_sleep(0.5, 1.0)
                for _ in range(10):
                    try:
                        after_sig = page.locator("table").first.inner_text(timeout=2000)
                        if after_sig != before_sig:
                            return True
                    except Exception:
                        pass
                    stable_sleep(0.2, 0.5)
            except Exception:
                pass
    return False

def load_seen(path: str) -> set:
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return set()
    try:
        df = pd.read_csv(path, usecols=["case_ref"])
        return set(map(str, df["case_ref"].dropna().astype(str)))
    except Exception:
        return set()

def append_one(row: dict, path: str):
    exists = os.path.exists(path)
    empty = (not exists) or os.path.getsize(path) == 0
    pd.DataFrame([row]).to_csv(path, mode="a", index=False, header=empty)
    # extra-sure flush
    try:
        with open(path, "a") as f:
            f.flush()
            os.fsync(f.fileno())
    except Exception:
        pass

# ---------------- Main ----------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", default="2018-2025", help="e.g., 2018-2025 or 2018,2020,2023")
    ap.add_argument("--max-per-year", type=int, default=0, help="0 = unlimited")
    ap.add_argument("--headless", action="store_true")
    args = ap.parse_args()

    years = parse_years_arg(args.years)
    max_per = args.max_per_year

    print("Saving CSV to:", os.path.abspath(OUT_CSV))
    seen = load_seen(OUT_CSV)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=args.headless,
            args=["--start-maximized","--disable-blink-features=AutomationControlled"]
        )
        context = browser.new_context(viewport={"width":1366,"height":900})
        page = context.new_page()

        for y in years:
            print(f"\n================ YEAR {y} ================")
            try:
                page.goto(SEARCH_URL, wait_until="domcontentloaded", timeout=15000)
            except Exception as e:
                print(f"❌ goto failed for year {y}: {e}")
                continue

            # Case type
            try:
                page.select_option("select[name='case_type']", label=CASE_TYPE_LABEL)
            except Exception:
                try:
                    page.select_option("select[name='case_type']", value="AO")
                except Exception as e:
                    print(f"❌ case_type select failed: {e}")
                    continue

            # Year input/select
            try:
                if page.locator("input[name='year']").count():
                    page.fill("input[name='year']", str(y))
                elif page.locator("select[name='year']").count():
                    page.select_option("select[name='year']", value=str(y))
            except Exception as e:
                print(f"⚠️ year selection warning: {e}")

            # Disposed
            try:
                r = page.locator("input[type='radio'][value='D']").first
                if r.count():
                    r.check()
            except Exception:
                pass

            # Manual CAPTCHA
            wait_user("📝 Type CAPTCHA and click GO on the page, then press ENTER here.")

            tries = 0
            while not detect_results(page):
                tries += 1
                if tries > 6:
                    print("❌ No results detected after several attempts. Skipping year.")
                    break
                print("⚠️ No results yet (perhaps CAPTCHA incorrect). Solve again, click GO, then press ENTER.")
                wait_user()
            if tries > 6:
                continue

            saved_this_year = 0

            while True:
                if is_captcha(page):
                    print("⚠️ CAPTCHA appeared again; solve it and click GO, then press ENTER here.")
                    wait_user()
                    if not detect_results(page):
                        print("⚠️ Still no results table; retrying...")
                        continue

                rows = get_case_rows(page)
                if not rows:
                    break

                for r in rows:
                    if max_per and saved_this_year >= max_per:
                        break

                    cref = (r.get("case_ref") or "").strip()
                    if not cref:
                        continue
                    if cref in seen:
                        continue

                    det = {}
                    # Try: new tab opens
                    try:
                        with context.expect_page(timeout=4000) as newp_evt:
                            r["view_el"].click()
                        new_pg = newp_evt.value
                        new_pg.wait_for_load_state("domcontentloaded", timeout=8000)
                        det = details_to_dict(new_pg)
                        new_pg.close()
                    except TE:
                        # Try: same-tab navigation
                        try:
                            with page.expect_navigation(wait_until="domcontentloaded", timeout=8000):
                                r["view_el"].click()
                            det = details_to_dict(page)
                            page.go_back(wait_until="domcontentloaded")
                        except Exception:
                            # Last fallback: AJAX/modal
                            try:
                                r["view_el"].click()
                                stable_sleep(0.8, 1.2)
                                det = details_to_dict(page)
                                try:
                                    page.go_back(wait_until="domcontentloaded")
                                except Exception:
                                    pass
                            except Exception:
                                pass

                    merged = {
                        "case_ref": cref,
                        "petitioner": r.get("petitioner",""),
                        "respondent": r.get("respondent",""),
                        **det,
                        "year": y,
                        "case_type": "AO",
                        "status": "Disposed",
                    }

                    append_one(merged, OUT_CSV)
                    seen.add(cref)
                    saved_this_year += 1
                    print(f"✓ saved {cref} (year {y} total {saved_this_year})")
                    stable_sleep(0.3, 0.8)

                if max_per and saved_this_year >= max_per:
                    break
                if not click_next(page):
                    break
                stable_sleep(0.6, 1.2)

        browser.close()

if __name__ == "__main__":
    # make console prompts immediate
    try:
        reconfig = getattr(sys.stdout, "reconfigure", None)
        if callable(reconfig):
            reconfig(line_buffering=True)
    except Exception:
        pass
    main()
