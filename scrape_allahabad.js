// scrape_allahabad.js
// Automates: Case Status -> Allahabad High Court (court+bench) -> Case Type A227 -> Years 2018..2025 -> downloads all orders.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const START_YEAR = 2018;
const END_YEAR = 2025;
const DOWNLOAD_BASE = path.resolve(__dirname, 'downloads');

const HUMAN_DELAY = 400;
const NAV_TIMEOUT = 45_000;
const SLOW_NET_WAIT = 2500;

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function sanitize(s) { return String(s).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 180); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HIGH_COURT_SELECTOR_CANDIDATES = [
  'select#sess_state_code',
  'select[name="sess_state_code"]',
  'select[id*="highcourt"]',
  'select[name*="highcourt"]',
  'select[name*="high_court"]',
  'select#highcourt',
  'select[name*="court_code"]',
  'select#court_code'
];

const BENCH_SELECTOR_CANDIDATES = [
  'select#court_complex_code',
  'select[name="court_complex_code"]',
  'select[id*="bench"]',
  'select[name*="bench"]',
  'select[name*="court_complex"]',
  'select#bench'
];

const CASE_TYPE_SELECTOR_CANDIDATES = [
  'select#case_type',
  'select[name="case_type"]',
  'select[name*="case_type"]',
  'select#caseType',
  'select[id*="caseType"]',
  'select[id*="case_type"]'
];

const CASE_TYPE_OPTION_REGEX = /A227\s+MATTERS\s+UNDER\s+ARTICLE\s+227/i;

function regexSource(optionMatcher) {
  return optionMatcher instanceof RegExp ? optionMatcher.source : String(optionMatcher);
}

function owningPage(scope) {
  return typeof scope?.page === 'function' ? scope.page() : scope;
}

async function waitForDropdownOption(scope, selectors, optionRegex, timeout = 8000) {
  const deadline = Date.now() + timeout;
  const matcherSource = regexSource(optionRegex);
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const dropdown = scope.locator(selector).first();
      if (!(await dropdown.count())) continue;
      if (!await dropdown.isVisible().catch(() => false)) continue;
      const hasMatch = await dropdown.evaluate((el, regexSource) => {
        const regex = new RegExp(regexSource, 'i');
        return Array.from(el.options || []).some((opt) => regex.test(opt.textContent || '') || regex.test(opt.value || ''));
      }, matcherSource).catch(() => false);
      if (hasMatch) return true;
    }
    await wait(200);
  }
  return false;
}

async function selectDropdownOption(scope, selectors, optionRegex, label) {
  const matcherSource = regexSource(optionRegex);
  for (const selector of selectors) {
    const dropdown = scope.locator(selector).first();
    if (!(await dropdown.count())) continue;
    if (!await dropdown.isVisible().catch(() => false)) continue;
    try {
      await dropdown.scrollIntoViewIfNeeded().catch(() => {});
      const match = await dropdown.evaluate((el, regexSource) => {
        const regex = new RegExp(regexSource, 'i');
        const opts = Array.from(el.options || []).map((opt) => ({
          text: (opt.textContent || '').trim(),
          value: opt.value,
        }));
        return opts.find((opt) => regex.test(opt.text) || regex.test(opt.value)) || null;
      }, matcherSource);
      if (!match) continue;
      await dropdown.selectOption(match.value).catch(async () => {
        await dropdown.selectOption({ label: match.text }).catch(async () => {
          await dropdown.evaluate((el, value) => {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, match.value);
        });
      });
      console.log(`${label}: selected "${match.text || match.value}"`);
      return true;
    } catch {}
  }
  console.warn(`${label}: unable to locate dropdown or matching option.`);
  return false;
}

async function selectFromScopes(scopes, selectors, optionRegex, label) {
  for (const scope of scopes) {
    try {
      const ready = await waitForDropdownOption(scope, selectors, optionRegex).catch(() => false);
      if (!ready) continue;
      if (await selectDropdownOption(scope, selectors, optionRegex, label)) return scope;
    } catch {}
  }
  return null;
}

async function selectOptionFromDropdown(dropdown, optionRegex, label) {
  if (!dropdown) return false;
  try { await dropdown.scrollIntoViewIfNeeded().catch(() => {}); } catch {}

  const match = await dropdown.evaluate((el, regexSource) => {
    const regex = new RegExp(regexSource, 'i');
    const opts = Array.from(el.options || []).map((opt) => ({
      text: (opt.textContent || '').trim(),
      value: opt.value,
    }));
    return opts.find((opt) => regex.test(opt.text) || regex.test(opt.value)) || null;
  }, regexSource(optionRegex)).catch(() => null);

  if (!match) return false;

  await dropdown.selectOption(match.value).catch(async () => {
    await dropdown.selectOption({ label: match.text }).catch(async () => {
      await dropdown.evaluate((el, value) => {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, match.value);
    });
  });

  const confirmed = await dropdown.evaluate((el, regexSource) => {
    const regex = new RegExp(regexSource, 'i');
    const opt = el.options?.[el.selectedIndex];
    if (!opt) return false;
    const text = (opt.textContent || '').trim();
    return regex.test(text) || regex.test(opt.value || '');
  }, regexSource(optionRegex)).catch(() => false);

  if (confirmed) console.log(`${label}: selected "${match.text || match.value}"`);
  else console.warn(`${label}: selection may not have stuck.`);

  return confirmed;
}

async function selectHighCourt(scope) {
  return selectDropdownOption(scope, HIGH_COURT_SELECTOR_CANDIDATES, /allahabad/, 'High Court');
}

async function selectBench(scope) {
  const ready = await waitForDropdownOption(scope, BENCH_SELECTOR_CANDIDATES, /allahabad/);
  if (!ready) console.warn('Bench: options not ready after waiting, trying anyway.');
  return selectDropdownOption(scope, BENCH_SELECTOR_CANDIDATES, /allahabad/, 'Bench');
}

// Gracefully click any visible "OK" button rendered as part of a JS modal (not a native alert).
async function dismissVisibleOk(page, timeout = 4000) {
  const deadline = Date.now() + timeout;
  const targets = () => [page, ...page.frames()];
  while (Date.now() < deadline) {
    for (const scope of targets()) {
      const okLocator = scope
        .getByRole('button', { name: /^ok$/i })
        .or(scope.getByRole('link', { name: /^ok$/i }))
        .or(scope.locator('input[type="button"][value="OK"], input[type="submit"][value="OK"], input[value="OK"]'))
        .or(scope.getByText(/^ok$/i));
      const ok = okLocator.first();
      if (await ok.isVisible().catch(() => false)) {
        try {
          await ok.click({ timeout: 1000 });
          await wait(200);
          return true;
        } catch {}
      }
    }
    await wait(200);
  }
  return false;
}

async function getFormScope(page) {
  for (const f of page.frames()) if (await f.locator('#searchbtn').count().catch(() => 0)) return f;
  for (const f of page.frames()) {
    const hasAny = await f.locator('select#case_type, select[name*="case_type"], select#year, select[name*="year"]').count().catch(() => 0);
    if (hasAny) return f;
  }
  return page;
}

async function ensureCaseTypeTab(page) {
  const scopes = [page, ...page.frames()];
  const tabSelectors = [
    '#CSHorizontalMenu div.caseType',
    '#CSHorizontalMenu div.caseType a',
    '#CSHorizontalMenu div.casetype',
    '#COHorizontalMenu div.caseType',
    '[role="tab"]:has-text("Case Type")',
    'a:has-text("Case Type")',
    'button:has-text("Case Type")',
    'div:has-text("Case Type")'
  ];

  let clicked = false;
  for (const scope of scopes) {
    for (const selector of tabSelectors) {
      const tab = scope.locator(selector).filter({ hasText: /case\s*type/i }).first();
      if (!(await tab.count())) continue;
      if (!await tab.isVisible().catch(() => false)) continue;
      await tab.scrollIntoViewIfNeeded().catch(() => {});
      try {
        await tab.click({ timeout: 1000 });
      } catch {
        await tab.dispatchEvent('click').catch(() => {});
      }
      await wait(400);
      clicked = true;
      break;
    }
    if (clicked) break;
  }

  if (!clicked) {
    await page.evaluate(() => {
      try {
        const tab = document.querySelector('#CSHorizontalMenu div.caseType, #CSHorizontalMenu div.casetype, [role="tab"].caseType, a[href*="caseType"]');
        if (tab) {
          tab.scrollIntoView({ block: 'center' });
          tab.click();
        }
      } catch {}
    }).catch(() => {});
    await wait(400);
  }

  const formScope = await getFormScope(page);
  const dropdownSelector = CASE_TYPE_SELECTOR_CANDIDATES.join(', ');
  const dropdown = formScope.locator(dropdownSelector).first();
  if (await dropdown.count()) {
    await dropdown.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
    return true;
  }
  return false;
}

async function buildCaseTypeScopes(page, baseScope) {
  const scopes = [];
  const seen = new Set();
  const push = (s) => { if (s && !seen.has(s)) { seen.add(s); scopes.push(s); } };
  push(baseScope);
  push(page);
  const formScope = await getFormScope(page);
  push(formScope);
  for (const frame of page.frames()) push(frame);
  return scopes;
}

async function locateCaseTypeDropdown(scopes) {
  for (const scope of scopes) {
    const dropdown = scope.locator('select').filter({
      has: scope.locator('option', { hasText: CASE_TYPE_OPTION_REGEX }),
    }).first();
    if (await dropdown.count()) return dropdown;
  }
  return null;
}

async function selectByLabel(scope, labelRegex, optionRegex) {
  const label = scope.getByLabel(labelRegex, { exact: false });
  if (await label.count()) {
    await label.selectOption({ label: new RegExp(optionRegex, 'i') }).catch(async () => {
      await label.selectOption({ value: new RegExp(optionRegex, 'i') }).catch(() => {});
    });
    return true;
  }
  return false;
}

async function selectCaseType(scope) {
  const page = owningPage(scope);
  await ensureCaseTypeTab(page);

  const deadline = Date.now() + 15_000;
  let dropdown = null;
  while (Date.now() < deadline) {
    const scopes = await buildCaseTypeScopes(page, scope);
    dropdown = await locateCaseTypeDropdown(scopes);
    if (dropdown) break;
    await wait(300);
  }

  if (!dropdown) {
    console.warn('Case Type: dropdown not found or option unavailable, unable to select.');
    return false;
  }

  return selectOptionFromDropdown(dropdown, CASE_TYPE_OPTION_REGEX, 'Case Type');
}

async function selectYear(scope, year) {
  const byLabel = scope.getByLabel(/year/i);
  if (await byLabel.count()) {
    await byLabel.selectOption(String(year)).catch(async () => {
      await byLabel.selectOption({ label: new RegExp(String(year)) }).catch(() => {});
    });
    return;
  }
  const sel = scope.locator('select[name*="year"], select#year');
  if (await sel.count()) {
    await sel.first().selectOption(String(year)).catch(async () => {
      await sel.first().selectOption({ label: new RegExp(String(year)) }).catch(() => {});
    });
  }
}

async function clickSearch(page) {
  const scope = await getFormScope(page);
  let btn = scope.locator('#searchbtn:visible').first();
  if (!(await btn.count())) {
    btn = scope.getByRole('button', { name: /search|submit|go/i }).first();
    if (!(await btn.count())) btn = scope.getByRole('link', { name: /search/i }).first();
  }
  try {
    if (await btn.count()) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 5000 });
      await scope.waitForLoadState('domcontentloaded').catch(() => {});
      await wait(SLOW_NET_WAIT);
      return;
    }
  } catch {}
  try {
    await scope.evaluate(() => { if (typeof window.funViewCinoHistory === 'function') window.funViewCinoHistory(); });
    await scope.waitForLoadState?.('domcontentloaded').catch(() => {});
    await wait(SLOW_NET_WAIT);
    return;
  } catch {}
  await page.evaluate(() => { if (typeof window.funViewCinoHistory === 'function') window.funViewCinoHistory(); }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await wait(SLOW_NET_WAIT);
}

async function downloadFromLinks(scope, linkLocator, outDir) {
  const cnt = await linkLocator.count();
  let downloaded = 0;
  let skipped = 0;

  for (let j = 0; j < cnt; j++) {
    const link = linkLocator.nth(j);
    let label = await link.innerText().catch(() => `order_${j + 1}`);
    label = sanitize(label || `order_${j + 1}`);
    const targetPath = path.join(outDir, `${label}.pdf`);
    if (fs.existsSync(targetPath)) {
      console.log('    -> Skipping existing file:', targetPath);
      skipped++;
      continue;
    }

    const [popupP, downloadP] = [
      scope.page().waitForEvent('popup').catch(() => null),
      scope.page().waitForEvent('download').catch(() => null)
    ];
    await link.click({ button: 'middle' }).catch(async () => { await link.click().catch(() => {}); });

    const popup = await popupP;
    const download = await downloadP;

    if (download) {
      const suggested = sanitize(download.suggestedFilename());
      const ext = path.extname(suggested).toLowerCase() || '.pdf';
      const finalPath = targetPath.endsWith('.pdf') ? targetPath : `${targetPath}${ext}`;
      await download.saveAs(finalPath).catch(() => {});
      await wait(250);
      if (fs.existsSync(finalPath)) {
        console.log('    -> Saved via download:', finalPath);
        downloaded++;
      } else {
        console.warn('    -> Download event fired but file missing:', finalPath);
      }
    } else if (popup) {
      try {
        await popup.waitForLoadState('load', { timeout: 15000 });
        const url = popup.url();
        if (/\.pdf($|\?)/i.test(url)) {
          const resp = await popup.waitForResponse((r) => r.url() === url && r.status() === 200, { timeout: 10000 }).catch(() => null);
          const buf = resp ? await resp.body().catch(() => null) : null;
          if (buf) {
            fs.writeFileSync(targetPath, buf);
            console.log('    -> Saved via popup fetch:', targetPath);
            downloaded++;
          } else {
            console.warn('    -> Popup returned no data for URL:', url);
          }
        } else {
          console.warn('    -> Popup URL did not look like a PDF:', url);
        }
      } catch (err) {
        console.warn('    -> Popup handling failed:', err?.message || err);
      }
      if (!popup.isClosed()) await popup.close().catch(() => {});
      await wait(250);
    } else {
      console.warn('    -> No download or popup detected for:', label);
    }
  }

  return { downloaded, skipped, attempted: cnt };
}

async function downloadAllOrders(scopePage, outDir) {
  const orderLinks =
    scopePage.getByRole('link', { name: /order|download|pdf/i })
      .or(scopePage.getByRole('button', { name: /order|download|pdf/i }))
      .or(scopePage.locator('a[href*=".pdf" i], a[href*="download" i], a[href*="order" i]'));

  let n = await orderLinks.count().catch(() => 0);
  if (n) return downloadFromLinks(scopePage, orderLinks, outDir);

  for (const f of scopePage.frames()) {
    const inner =
      f.getByRole('link', { name: /order|download|pdf/i })
        .or(f.getByRole('button', { name: /order|download|pdf/i }))
        .or(f.locator('a[href*=".pdf" i], a[href*="download" i], a[href*="order" i]'));
    if (await inner.count()) return downloadFromLinks(f, inner, outDir);
  }

  console.log('    -> No order links detected for this case.');
  return { downloaded: 0, skipped: 0, attempted: 0 };
}

async function processResultPages(page, yearOutputDir) {
  let scope = await getFormScope(page);

  while (true) {
    const captcha = scope.getByText(/captcha|enter code|verify/i).first();
    if (await captcha.isVisible().catch(() => false)) { console.log('CAPTCHA detected - solve it in the browser. Waiting 20s...'); await wait(20000); }

    let viewButtons = scope.getByRole('link', { name: /^view$/i })
      .or(scope.getByRole('button', { name: /^view$/i }))
      .or(scope.getByText(/^view$/i).locator('xpath=ancestor-or-self::a|ancestor-or-self::button'));

    let count = await viewButtons.count().catch(() => 0);
    if (!count) {
      const f = page.frames().find(fr => /result|case/i.test(fr.url()) || /result/i.test(fr.name()));
      if (f) { scope = f; continue; }
    }

    for (let i = 0; i < count; i++) {
      const btn = viewButtons.nth(i);
      let caseLabel = `case_${i + 1}`;
      try {
        const row = await btn.locator('xpath=ancestor::tr[1]').innerText({ timeout: 2000 }).catch(() => '');
        const m = row.match(/(CNR\s*:\s*\w+|\b\d{1,6}\/\d{4}\b)/i);
        caseLabel = sanitize(m ? m[1].replace(/\s+/g, '_') : row.split('\n')[0] || caseLabel);
      } catch {}
      const caseDir = path.join(yearOutputDir, caseLabel);
      ensureDir(caseDir);
      console.log(`  - Case: ${caseLabel}`);

      const [maybePopup] = await Promise.all([
        page.waitForEvent('popup').catch(() => null),
        btn.click({ delay: 50 })
      ]);

      const casePage = maybePopup ?? page;
      if (maybePopup) { await maybePopup.waitForLoadState('domcontentloaded').catch(() => {}); await wait(SLOW_NET_WAIT); }
      else { await wait(1200); }

      let stats = { downloaded: 0, skipped: 0, attempted: 0 };
      try { stats = await downloadAllOrders(casePage, caseDir); } catch (e) { console.warn('Order download error:', e.message); }
      console.log(`    -> Orders downloaded: ${stats.downloaded}, skipped: ${stats.skipped}, links found: ${stats.attempted}`);

      if (maybePopup && !maybePopup.isClosed()) { await maybePopup.close().catch(() => {}); await wait(300); }
    }

    const nextBtn = scope.getByRole('link', { name: /^next$/i })
      .or(scope.getByRole('button', { name: /^next$/i }))
      .or(scope.getByText(/^next$/i).locator('xpath=ancestor-or-self::a|ancestor-or-self::button'));
    if (await nextBtn.first().isVisible().catch(() => false) && await nextBtn.first().isEnabled().catch(() => false)) {
      await nextBtn.first().click().catch(() => {});
      await wait(SLOW_NET_WAIT);
      scope = await getFormScope(page);
      continue;
    }
    break;
  }
}

(async function run() {
  ensureDir(DOWNLOAD_BASE);

  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 850 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);

  // Global safety: auto-accept stray JS alerts
  page.on('dialog', async (d) => { try { await d.accept(); } catch {} });

  await page.goto('https://hcservices.ecourts.gov.in/hcservices/main.php#', { waitUntil: 'domcontentloaded' });
  await wait(SLOW_NET_WAIT);

  // Click "Case Status" and IMMEDIATELY accept the "Please Select Highcourt and Bench..." alert.
  const caseStatusLink = page.getByRole('link', { name: /case status/i }).or(page.getByText(/case status/i));
  await Promise.race([
    (async () => {
      const dialog = await page.waitForEvent('dialog', { timeout: 15000 }).catch(() => null);
      if (dialog) { console.log('Popup:', dialog.message()); await dialog.accept(); }
    })(),
    (async () => { await caseStatusLink.first().click().catch(() => {}); })()
  ]);
  // In case the alert appeared a bit late:
  const late = await page.waitForEvent('dialog', { timeout: 2000 }).catch(() => null);
  if (late) { console.log('Late popup:', late.message()); await late.accept(); }
  await dismissVisibleOk(page).catch(() => {});

  await page.waitForLoadState('domcontentloaded');
  await wait(SLOW_NET_WAIT);

  await ensureCaseTypeTab(page);
  let formScope = await getFormScope(page);

  // Court & Bench (idempotent)
  if (!await selectByLabel(formScope, /high\s*court/i, /allahabad/i).catch(() => false)) {
    await selectHighCourt(formScope);
  }
  await wait(HUMAN_DELAY);
  await selectBench(formScope);
  await wait(HUMAN_DELAY);

  const initialCaseType = await selectCaseType(formScope);
  if (!initialCaseType) console.warn('Case Type: initial selection failed, please verify manually.');
  await wait(HUMAN_DELAY);

  for (let year = START_YEAR; year <= END_YEAR; year++) {
    console.log(`\n=== YEAR ${year} ===`);
    const yearDir = path.join(DOWNLOAD_BASE, String(year));
    ensureDir(yearDir);

    formScope = await getFormScope(page);
    await ensureCaseTypeTab(page);

    const highCourtViaLabel = await selectByLabel(formScope, /high\s*court/i, /allahabad/i).catch(() => false);
    if (!highCourtViaLabel) {
      await selectHighCourt(formScope);
    }
    await wait(HUMAN_DELAY);
    await selectBench(formScope);
    await wait(HUMAN_DELAY);

    const caseTypeSelected = await selectCaseType(formScope);
    if (!caseTypeSelected) console.warn('Case Type: yearly reselection failed, please verify manually.');
    await wait(HUMAN_DELAY);

    await selectYear(formScope, year);
    await wait(HUMAN_DELAY);

    await clickSearch(page);
    await processResultPages(page, yearDir);

    formScope = await getFormScope(page);
    try {
      const backBtn = formScope.getByRole('link', { name: /back/i }).or(formScope.getByRole('button', { name: /back/i }));
      if (await backBtn.first().isVisible()) { await backBtn.first().click().catch(() => {}); await wait(1200); }
    } catch {}
  }

  console.log('\nAll done.');
  await browser.close();
})().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
