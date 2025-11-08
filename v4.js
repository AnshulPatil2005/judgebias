// scrape_allahabad.js
// Full rewrite (2025-11-05): 
// - Robust Case Type selection (#case_type44) AFTER radio + year
// - Scrapes Petitioner/Respondent from the exact span selectors you provided
// - Year-based folders: downloads/<YEAR>/ for PDFs + Excel
// - Excel has NO index or viewButtonIndex columns
// - Frame-aware, resilient selectors, popup handling

// HOW TO RUN
// PowerShell:
//   $env:CASE_YEAR="2018"; $env:CASE_TYPE="A227(MATTERS)"; node v4.js
// cmd.exe:
//   set CASE_YEAR=2018 && set CASE_TYPE=A227(MATTERS) && node scrape_allahabad.js
// bash/zsh:
//   CASE_YEAR=2018 CASE_TYPE="A227(MATTERS)" node scrape_allahabad.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// --------------------- Config ---------------------
const HUMAN_DELAY = 350;
const NAV_TIMEOUT = 45_000;
const SLOW_NET_WAIT = 2200;

const TARGET_YEAR = String(process.env.CASE_YEAR || '2018').trim();
const TARGET_CASE_TYPE = String(process.env.CASE_TYPE || '').trim(); // e.g., "A227(MATTERS)" or "Writ.*C"

const DOWNLOAD_BASE = path.resolve(__dirname, 'downloads');
const YEAR_DIR = path.join(DOWNLOAD_BASE, TARGET_YEAR);

// --------------------- FS utils -------------------
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
ensureDir(DOWNLOAD_BASE); ensureDir(YEAR_DIR);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const owningPage = (scope) => (typeof scope?.page === 'function' ? scope.page() : scope);

// --------------------- Common selectors -----------
const HIGH_COURT_SELECTOR_CANDIDATES = [
  'select#sess_state_code',
  'select[name="sess_state_code"]',
  'select#highcourt',
  'select[id*="highcourt"]',
  'select[name*="highcourt"]',
  'select[name*="court_code"]'
];
const BENCH_SELECTOR_CANDIDATES = [
  'select#court_complex_code',
  'select[name="court_complex_code"]',
  'select#bench',
  'select[id*="bench"]',
  'select[name*="bench"]',
  'select[name*="court_complex"]'
];
const HIGH_COURT_OPTION_REGEX = /allahabad/i;
const BENCH_OPTION_REGEX = /\b(allahabad|lucknow)\b/i;

// --------------------- Dropdown helpers -----------
async function waitPopulatedEnabled(dd, timeout = 20000) {
  await dd.waitFor({ state: 'visible', timeout: Math.min(15000, timeout) });
  const handle = await dd.elementHandle();
  await dd.page().waitForFunction((el) => {
    if (!el) return false;
    if (el.disabled) return false;
    const opts = Array.from(el.options || []);
    if (opts.length < 2) return false;
    return opts.some(o => !o.disabled && (o.value || o.textContent));
  }, handle, { timeout });
}

async function selectByRegexOrFirst(dd, wantedPattern) {
  await dd.scrollIntoViewIfNeeded().catch(() => {});
  await dd.click({ timeout: 1500 }).catch(() => {});

  const match = await dd.evaluate((el, pattern) => {
    const norm = (s) => (s || '').trim().replace(/\s+/g, ' ');
    const opts = Array.from(el.options || []).map(o => ({
      text: norm(o.textContent),
      value: String(o.value || '').trim(),
      disabled: !!o.disabled
    }));
    const usable = (o) => !o.disabled && (o.value || o.text) && !/^\s*(select|choose|--)/i.test(o.text);

    let cand = null;
    if (pattern && pattern.length) {
      const re = new RegExp(pattern, 'i');
      cand = opts.find(o => usable(o) && re.test(o.text)) || opts.find(o => usable(o) && re.test(o.value));
    }
    if (!cand) cand = opts.find(usable);
    return cand || null;
  }, wantedPattern);

  if (!match) return false;

  let manual = false;
  await dd.selectOption(match.value).catch(async () => {
    await dd.selectOption({ label: match.text }).catch(async () => {
      await dd.evaluate((el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, match.value);
      manual = true;
    });
  });
  if (!manual) {
    await dd.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(() => {});
  }

  const ok = await dd.evaluate((el, v, t) => {
    const o = el.options?.[el.selectedIndex];
    if (!o) return false;
    const selVal = String(o.value || '').trim();
    const selTxt = (o.textContent || '').trim();
    return selVal === v || selTxt === t;
  }, match.value, match.text);

  return ok;
}

async function selectFirstUsable(dd, label) {
  const option = await dd.evaluate((el) => {
    const norm = (s) => (s || '').trim();
    const opts = Array.from(el.options || []);
    const usable = (o) => !o.disabled && (o.value || o.textContent) && !/^\s*(select|choose|--)/i.test(norm(o.textContent));
    const cand = opts.find(usable);
    return cand ? { value: String(cand.value || '').trim(), text: norm(cand.textContent) } : null;
  });
  if (!option) return false;

  let manual = false;
  await dd.selectOption(option.value).catch(async () => {
    await dd.selectOption({ label: option.text }).catch(async () => {
      await dd.evaluate((el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, option.value);
      manual = true;
    });
  });
  if (!manual) {
    await dd.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(() => {});
  }
  const ok = await dd.evaluate((el, v, t) => {
    const o = el.options?.[el.selectedIndex];
    if (!o) return false;
    return String(o.value || '').trim() === v || (o.textContent || '').trim() === t;
  }, option.value, option.text);
  if (!ok) console.warn(`${label}: selection may not have stuck.`);
  else console.log(`${label}: selected "${option.text || option.value}"`);
  return ok;
}

// --------------------- Page helpers ----------------
async function getFormScope(page) {
  for (const f of page.frames()) if (await f.locator('#searchbtn').count().catch(() => 0)) return f;
  for (const f of page.frames()) {
    const any = await f.locator('select#case_type44, select#case_type, select[name*="case_type"], #search_year').count().catch(() => 0);
    if (any) return f;
  }
  return page;
}

async function ensureCaseTypeTab(page) {
  const scopes = [page, ...page.frames()];
  const sels = [
    '#CSHorizontalMenu div.caseType',
    '#CSHorizontalMenu div.caseType a',
    '[role="tab"]:has-text("Case Type")',
    'a:has-text("Case Type")',
    'button:has-text("Case Type")'
  ];
  for (const s of scopes) {
    const tab = s.locator(sels.join(',')).filter({ hasText: /case\s*type/i }).first();
    if (await tab.count() && await tab.isVisible().catch(() => false)) {
      await tab.scrollIntoViewIfNeeded().catch(() => {});
      await tab.click({ timeout: 1200 }).catch(async () => tab.dispatchEvent('click').catch(() => {}));
      await wait(400);
      return true;
    }
  }
  await page.evaluate(() => {
    const el = document.querySelector('#CSHorizontalMenu div.caseType, [role="tab"].caseType, a[href*="caseType"]');
    if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
  }).catch(() => {});
  await wait(400);
  return true;
}

async function dismissVisibleOk(page, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const ok = scope
        .getByRole('button', { name: /^ok$/i })
        .or(scope.getByRole('link', { name: /^ok$/i }))
        .or(scope.locator('input[type="button"][value="OK"], input[type="submit"][value="OK"], input[value="OK"]'))
        .first();
      if (await ok.isVisible().catch(() => false)) {
        await ok.click({ timeout: 800 }).catch(() => {});
        await wait(150);
        return true;
      }
    }
    await wait(150);
  }
  return false;
}

async function selectHighCourt(scope) {
  const page = owningPage(scope);
  const scopes = [scope, page, ...page.frames()];
  for (const s of scopes) {
    const dd = s.locator(HIGH_COURT_SELECTOR_CANDIDATES.join(',')).first();
    if (!(await dd.count())) continue;
    try {
      await waitPopulatedEnabled(dd, 15000);
      const ok = await selectByRegexOrFirst(dd, HIGH_COURT_OPTION_REGEX.source);
      if (ok) return true;
    } catch {}
  }
  return false;
}

async function selectBench(scope) {
  const page = owningPage(scope);
  const scopes = [scope, page, ...page.frames()];
  await page.waitForFunction(() => {
    const el =
      document.querySelector('#court_complex_code, select[name="court_complex_code"]') ||
      document.querySelector('select#bench, select[id*="bench"], select[name*="bench"], select[name*="court_complex"]');
    return el && el.options && el.options.length > 1;
  }, { timeout: 12000 }).catch(() => {});
  for (const s of scopes) {
    const dd = s.locator(BENCH_SELECTOR_CANDIDATES.join(',')).first();
    if (!(await dd.count())) continue;
    try {
      await waitPopulatedEnabled(dd, 15000);
      const ok = await selectByRegexOrFirst(dd, BENCH_OPTION_REGEX.source);
      if (ok) return true;
    } catch {}
  }
  return false;
}

async function clickCScaseType(page) {
  const scopes = [page, ...page.frames()];
  for (const s of scopes) {
    const el = s.locator('#CScaseType').first();
    if (await el.count() && await el.isVisible().catch(() => false)) {
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 1200 }).catch(async () => el.dispatchEvent('click').catch(() => {}));
      await wait(400);
      return true;
    }
  }
  return false;
}

async function selectRadDCT(page) {
  const scopes = [page, ...page.frames()];
  for (const s of scopes) {
    const rb = s.locator('#radDCT').first();
    if (await rb.count()) {
      const checked = await rb.isChecked().catch(() => false);
      if (!checked) {
        await rb.scrollIntoViewIfNeeded().catch(() => {});
        await rb.click({ timeout: 1200 }).catch(async () => {
          await rb.evaluate((el) => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
        });
      }
      return true;
    }
  }
  return false;
}

async function inputYear(page) {
  const scopes = [page, ...page.frames()];
  for (const s of scopes) {
    const inp = s.locator('#search_year').first();
    if (await inp.count()) {
      await inp.scrollIntoViewIfNeeded().catch(() => {});
      await inp.click({ timeout: 1200 }).catch(() => {});
      await inp.fill('').catch(() => {});
      await inp.type(TARGET_YEAR, { delay: 50 }).catch(async () => {
        await inp.evaluate((el, y) => {
          el.value = y;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, TARGET_YEAR);
      });
      return true;
    }
  }
  return false;
}

// ----------- Case Type: #case_type44 (robust, blocks until populated)
async function selectCaseType44(page, wantedLabel = TARGET_CASE_TYPE) {
  console.log('Selecting Case Type (#case_type44)…');
  const scope = await getFormScope(page);
  const dd = scope.locator('#case_type44').first();

  await waitPopulatedEnabled(dd, 25000);

  const meta = await dd.evaluate((el) => {
    const opts = Array.from(el.options || []).map(o => (o.textContent || '').trim());
    return { disabled: el.disabled, len: opts.length, head: opts.slice(0, 8) };
  });
  console.log(`Case Type options=${meta.len}; sample: ${meta.head.join(' | ')}`);

  const ok = await selectByRegexOrFirst(dd, wantedLabel);
  if (!ok) {
    console.warn('Case Type: regex/text not matched; trying first usable…');
    return selectFirstUsable(dd, 'Case Type');
  }
  await wait(400);
  console.log('Case Type selected.');
  return true;
}

// --------------------- Results wait ----------------
async function waitForResultsTable(page) {
  console.log('\nSolve CAPTCHA and click Go… waiting for results…');
  const start = Date.now();
  while (Date.now() - start < 120000) {
    for (const s of [page, ...page.frames()]) {
      const t = s.locator('#showList').first();
      if (await t.count() && await t.isVisible().catch(() => false)) {
        console.log('✅ Results table visible.');
        await wait(800);
        return true;
      }
    }
    await wait(1600);
    process.stdout.write(`\rWaiting… ${(Date.now() - start) / 1000 | 0}s`);
  }
  console.log('\n⏰ Timeout waiting for results.');
  return false;
}

// --------------------- Scrape details & PDFs -------
async function extractCaseDetails(page) {
  await wait(400);
  for (const s of [page, ...page.frames()]) {
    try {
      const data = await s.evaluate(() => {
        const norm = (x) => (x || '').trim().replace(/\s+/g, ' ');
        const get = (re) => {
          const cells = [...document.querySelectorAll('td,th')];
          const lab = cells.find(c => re.test(norm(c.textContent)));
          const v = lab?.nextElementSibling;
          return v ? norm(v.textContent) : '';
        };

        const out = {
          filingNumber:       get(/^\s*Filing\s*Number/i),
          filingDate:         get(/^\s*Filing\s*Date/i),
          registrationNumber: get(/^\s*Registration\s*Number/i),
          registrationDate:   get(/^\s*Registration\s*Date/i),
          cnrNumber:          get(/^\s*CNR\s*Number/i),
          firstHearingDate:   get(/^\s*First\s*Hearing\s*Date/i),
          decisionDate:       get(/^\s*Decision\s*Date/i),
          caseStatus:         get(/^\s*Case\s*Status/i),
          natureOfDisposal:   get(/^\s*Nature\s*of\s*Disposal/i),
          coram:              get(/^\s*Coram/i),
          benchType:          get(/^\s*Bench\s*Type/i),
          judicialBranch:     get(/^\s*Judicial\s*Branch/i),
          state:              get(/^\s*State/i),
          district:           get(/^\s*District/i),
          underActs:          get(/^\s*Under\s*Act/i),
          underSections:      get(/^\s*Under\s*Section/i),
          category:           get(/^\s*Category/i),
          subCategory:        get(/^\s*Sub\s*Category/i),
          petitionerAndAdvocate: '',
          respondentAndAdvocate: '',
          iaDetails: ''
        };

        // --- Priority: exact spans you specified ---
        const petSpan = document.querySelector('#caseHistoryDiv > div:nth-child(9) > div:nth-child(2) > span.Petitioner_Advocate_table');
        const resSpan = document.querySelector('#caseHistoryDiv > div:nth-child(9) > div:nth-child(2) > span.Respondent_Advocate_table');
        if (petSpan) out.petitionerAndAdvocate = norm(petSpan.textContent);
        if (resSpan) out.respondentAndAdvocate = norm(resSpan.textContent);

        // --- Fallback: table-based parse if spans absent/empty ---
        const empty = (t) => !t || !t.length;
        if (empty(out.petitionerAndAdvocate) || empty(out.respondentAndAdvocate)) {
          const cells = [...document.querySelectorAll('td,th')];
          const pickSection = (titleRe, stopRe) => {
            const hdr = cells.find(el => titleRe.test(norm(el.textContent)));
            if (!hdr) return '';
            const table = hdr.closest('table');
            if (!table) return '';
            const rows = [...table.querySelectorAll('tr')];
            const outRows = [];
            let on = false;
            for (const r of rows) {
              const t = norm(r.textContent);
              if (titleRe.test(t)) { on = true; continue; }
              if (stopRe.test(t)) break;
              if (on && t) outRows.push(t);
            }
            return outRows.join('; ');
          };
          if (empty(out.petitionerAndAdvocate)) {
            out.petitionerAndAdvocate = pickSection(/Petitioner and Advocate/i, /Respondent and Advocate|Acts|Category/i);
          }
          if (empty(out.respondentAndAdvocate)) {
            out.respondentAndAdvocate = pickSection(/Respondent and Advocate/i, /Acts|Category/i);
          }
        }

        // IA table (if present)
        const cells2 = [...document.querySelectorAll('td,th')];
        const iaHdr = cells2.find(el => /IA Details/i.test(norm(el.textContent)));
        const ia = [];
        if (iaHdr) {
          const table = iaHdr.closest('table')?.nextElementSibling;
          if (table && table.tagName === 'TABLE') {
            const rows = [...table.querySelectorAll('tr')].slice(1);
            for (const r of rows) {
              const td = r.querySelectorAll('td');
              if (td.length >= 4) {
                ia.push({
                  iaNumber:     norm(td[0]?.textContent),
                  party:        norm(td[1]?.textContent),
                  dateOfFiling: norm(td[2]?.textContent),
                  iaStatus:     norm(td[3]?.textContent),
                });
              }
            }
          }
        }
        out.iaDetails = ia.length ? JSON.stringify(ia) : '';

        return out;
      });
      return data || {};
    } catch {}
  }
  return {};
}

async function downloadTablePDFs(page, context, viewIdx) {
  const rows = page.locator('table.order_table tr');
  const n = await rows.count();
  if (n <= 1) return false;

  let ok = 0;
  for (let i = 1; i < n; i++) {
    const row = rows.nth(i);
    const link = row.locator('a[href*="display_pdf.php"]').first();
    if (await link.count()) {
      const href = await link.getAttribute('href');
      try {
        const url = new URL(href, page.url()).href;
        const resp = await context.request.get(url);
        if (resp.status() === 200) {
          const buf = await resp.body();
          const fname = path.join(YEAR_DIR, `view_${viewIdx}_pdf_${i}.pdf`);
          fs.writeFileSync(fname, buf);
          ok++;
        }
      } catch {}
    }
    if (i < n - 1) await wait(500);
  }
  return ok > 0;
}

function saveExcel(rows, base = 'case_details') {
  if (!rows.length) return;
  const wb = XLSX.utils.book_new();

  // NOTE: No "index" or "viewButtonIndex" columns here
  const cols = [
    'filingNumber','filingDate','registrationNumber','registrationDate','cnrNumber',
    'firstHearingDate','decisionDate','caseStatus','natureOfDisposal','coram',
    'benchType','judicialBranch','state','district',
    'petitionerAndAdvocate','respondentAndAdvocate',
    'underActs','underSections','category','subCategory','iaDetails'
  ];

  const data = rows.map(r => Object.fromEntries(cols.map(k => [k, r[k] ?? ''])));
  const ws = XLSX.utils.json_to_sheet(data, { header: cols });
  XLSX.utils.book_append_sheet(wb, ws, 'Case Details');

  const out = path.join(YEAR_DIR, `${base}_${TARGET_YEAR}.xlsx`);
  XLSX.writeFile(wb, out);
  console.log(`✅ Excel saved: ${out}`);
}

// --------------------- Main -----------------------
(async function run() {
  const browser = await chromium.launch({ headless: false, args: ['--disable-blinkfeatures=AutomationControlled'] });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 850 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);

  page.on('dialog', async (d) => { try { await d.accept(); } catch {} });

  const allCaseData = [];
  process.on('SIGINT', () => {
    console.log('\n🛑 Interrupt. Saving partial…');
    saveExcel(allCaseData, 'case_details_partial');
    process.exit(0);
  });

  await page.goto('https://hcservices.ecourts.gov.in/hcservices/main.php#', { waitUntil: 'domcontentloaded' });
  await wait(SLOW_NET_WAIT);

  // Case Status
  const cs = page.getByRole('link', { name: /case status/i }).or(page.getByText(/case status/i));
  await Promise.race([
    page.waitForEvent('dialog', { timeout: 15000 }).then(d => d?.accept().catch(() => {})).catch(() => {}),
    cs.first().click().catch(() => {}),
  ]);
  await page.waitForLoadState('domcontentloaded');
  await dismissVisibleOk(page);

  // Case Type tab
  await ensureCaseTypeTab(page);
  await dismissVisibleOk(page);

  // High Court + Bench
  const hcScope = await getFormScope(page);
  const sess = hcScope.locator('select#sess_state_code').first();
  if (await sess.count()) {
    try {
      await waitPopulatedEnabled(sess, 15000);
      const ok = await selectByRegexOrFirst(sess, HIGH_COURT_OPTION_REGEX.source);
      if (ok) console.log('sess_state_code: selected "Allahabad High Court"');
    } catch {}
  } else {
    await selectHighCourt(hcScope);
  }
  await dismissVisibleOk(page);
  await selectBench(hcScope);
  await dismissVisibleOk(page);

  // Case Type flow
  await clickCScaseType(page);
  await dismissVisibleOk(page);
  await selectRadDCT(page);
  await dismissVisibleOk(page);
  await inputYear(page);
  await dismissVisibleOk(page);

  // >>> CRITICAL: select case type AFTER radio + year
  await selectCaseType44(page, TARGET_CASE_TYPE);
  await dismissVisibleOk(page);
  await wait(HUMAN_DELAY);

  // Wait for results table (solve captcha + Go manually)
  await waitForResultsTable(page);

  // Iterate "View" buttons (limit for safety)
  const viewSel = () =>
    page.getByRole('link', { name: /^view$/i })
      .or(page.getByRole('button', { name: /^view$/i }))
      .or(page.locator('a[href*="view_case"]'))
      .or(page.locator('a[href*="case_no="]'))
      .or(page.locator('input[type="button"][value*="view" i], input[type="submit"][value*="view" i]'));

  const total = await viewSel().count();
  console.log(`Found ${total} View buttons.`);
  const maxToProcess = Math.min(50, total);

  for (let i = 0; i < maxToProcess; i++) {
    console.log(`\n=== Case ${i + 1}/${maxToProcess} ===`);
    try {
      const btn = viewSel().nth(i);
      if (!(await btn.count())) { console.log('View not found.'); continue; }
      await btn.scrollIntoViewIfNeeded();
      await btn.click({ timeout: 2500 }).catch(() => {});
      await dismissVisibleOk(page);

      await Promise.race([
        page.waitForSelector('#bckbtn', { state: 'visible', timeout: 10000 }).catch(() => {}),
        page.waitForSelector('text=/Case Details|Filing Number|CNR Number/i', { timeout: 10000 }).catch(() => {}),
        page.waitForLoadState('networkidle').catch(() => {})
      ]);

      const details = await extractCaseDetails(page);
      if (Object.keys(details).length) {
        // NOTE: We DO NOT store any index or viewButtonIndex field
        allCaseData.push(details);
        console.log('Details captured.');
      } else {
        console.log('No details captured.');
      }

      const gotPDF = await downloadTablePDFs(page, context, i + 1);
      console.log(gotPDF ? 'PDF(s) downloaded.' : 'No PDFs.');

      const back = page.locator('#bckbtn').first();
      if (await back.count()) {
        await back.click({ timeout: 1500 }).catch(() => {});
      } else {
        await page.goBack().catch(() => {});
      }
      await wait(900);
      await page.waitForSelector('#showList', { state: 'visible', timeout: 10000 }).catch(() => {});
    } catch (e) {
      console.log('Case error:', e.message);
      try { await page.goBack(); await wait(900); } catch {}
    }
  }

  if (allCaseData.length) saveExcel(allCaseData, 'case_details');
  else console.log('No case data to save.');

  console.log('\nDone. Browser left open for inspection.');
  await new Promise(() => {});
})().catch((e) => { console.error('Fatal error:', e); process.exit(1); });
