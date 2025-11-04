// scrape_allahabad.js
// Automates: Case Status → Allahabad High Court (court+bench) → Case Type A227 → Years 2018..2025 → downloads all orders.

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
  const scope = await getFormScope(page);
  const tab = scope.getByRole('tab', { name: /case\s*type/i })
    .or(scope.getByText(/search by\s*case\s*type/i))
    .or(scope.getByLabel(/case\s*type/i));
  if (await tab.first().count()) { await tab.first().click().catch(() => {}); await wait(400); }
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
  const byLabel = scope.getByLabel(/case\s*type/i);
  if (await byLabel.count()) {
    await byLabel.selectOption({ label: /A227\s+MATTERS\s+UNDER\s+ARTICLE\s+227/i }).catch(async () => {
      const all = await byLabel.locator('option').allInnerTexts();
      const hit = all.find((t) => /A227\s+MATTERS\s+UNDER\s+ARTICLE\s+227/i.test(t));
      if (hit) await byLabel.selectOption({ label: hit });
    });
    return;
  }
  const sel = scope.locator('select[name*="case_type"], select#case_type');
  if (await sel.count()) {
    await sel.first().selectOption({ label: /A227\s+MATTERS\s+UNDER\s+ARTICLE\s+227/i }).catch(async () => {
      const opts = await sel.first().locator('option').allInnerTexts();
      const hit = opts.find((t) => /A227\s+MATTERS\s+UNDER\s+ARTICLE\s+227/i.test(t));
      if (hit) await sel.first().selectOption({ label: hit });
    });
  }
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
  for (let j = 0; j < cnt; j++) {
    const link = linkLocator.nth(j);
    let label = await link.innerText().catch(() => `order_${j + 1}`);
    label = sanitize(label || `order_${j + 1}`);
    const targetPath = path.join(outDir, `${label}.pdf`);
    if (fs.existsSync(targetPath)) continue;

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
      const finalPath = targetPath.endsWith('.pdf') ? targetPath : targetPath + ext;
      await download.saveAs(finalPath).catch(() => {});
      await wait(250);
    } else if (popup) {
      try {
        await popup.waitForLoadState('load', { timeout: 15000 });
        const url = popup.url();
        if (/\.pdf($|\?)/i.test(url)) {
          const resp = await popup.waitForResponse((r) => r.url() === url && r.status() === 200, { timeout: 10000 }).catch(() => null);
          const buf = resp ? await resp.body().catch(() => null) : null;
          if (buf) fs.writeFileSync(targetPath, buf);
        }
      } catch {}
      if (!popup.isClosed()) await popup.close().catch(() => {});
      await wait(250);
    }
  }
}

async function downloadAllOrders(scopePage, outDir) {
  const orderLinks =
    scopePage.getByRole('link', { name: /order|download|pdf/i })
      .or(scopePage.getByRole('button', { name: /order|download|pdf/i }))
      .or(scopePage.locator('a[href*=".pdf" i], a[href*="download" i], a[href*="order" i]'));

  let n = await orderLinks.count().catch(() => 0);
  if (n) { await downloadFromLinks(scopePage, orderLinks, outDir); return; }

  for (const f of scopePage.frames()) {
    const inner =
      f.getByRole('link', { name: /order|download|pdf/i })
        .or(f.getByRole('button', { name: /order|download|pdf/i }))
        .or(f.locator('a[href*=".pdf" i], a[href*="download" i], a[href*="order" i]'));
    if (await inner.count()) { await downloadFromLinks(f, inner, outDir); return; }
  }
}

async function processResultPages(page, yearOutputDir) {
  let scope = await getFormScope(page);

  while (true) {
    const captcha = scope.getByText(/captcha|enter code|verify/i).first();
    if (await captcha.isVisible().catch(() => false)) { console.log('CAPTCHA detected — solve it in the browser. Waiting 20s…'); await wait(20000); }

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

      const [maybePopup] = await Promise.all([
        page.waitForEvent('popup').catch(() => null),
        btn.click({ delay: 50 })
      ]);

      const casePage = maybePopup ?? page;
      if (maybePopup) { await maybePopup.waitForLoadState('domcontentloaded').catch(() => {}); await wait(SLOW_NET_WAIT); }
      else { await wait(1200); }

      try { await downloadAllOrders(casePage, caseDir); } catch (e) { console.warn('Order download error:', e.message); }

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
  await selectByLabel(formScope, /high\s*court/i, /allahabad/i).catch(() => {});
  await wait(HUMAN_DELAY);
  const benchSel = formScope.locator('select[name*="bench"], select#bench');
  if (await benchSel.count()) {
    await benchSel.first().selectOption({ label: /allahabad.*high\s*court/i }).catch(async () => {
      const opts = await benchSel.first().locator('option').allInnerTexts();
      const val = opts.find((t) => /allahabad.*high\s*court/i.test(t));
      if (val) await benchSel.first().selectOption({ label: val });
    });
  }
  await wait(HUMAN_DELAY);

  await selectCaseType(formScope);
  await wait(HUMAN_DELAY);

  for (let year = START_YEAR; year <= END_YEAR; year++) {
    console.log(`\n=== YEAR ${year} ===`);
    const yearDir = path.join(DOWNLOAD_BASE, String(year));
    ensureDir(yearDir);

    formScope = await getFormScope(page);
    await ensureCaseTypeTab(page);

    await selectByLabel(formScope, /high\s*court/i, /allahabad/i).catch(() => {});
    await wait(HUMAN_DELAY);

    const benchSel2 = formScope.locator('select[name*="bench"], select#bench');
    if (await benchSel2.count()) {
      await benchSel2.first().selectOption({ label: /allahabad.*high\s*court/i }).catch(async () => {
        const opts = await benchSel2.first().locator('option').allInnerTexts();
        const val = opts.find((t) => /allahabad.*high\s*court/i.test(t));
        if (val) await benchSel2.first().selectOption({ label: val });
      });
    }
    await wait(HUMAN_DELAY);

    await selectCaseType(formScope);
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
