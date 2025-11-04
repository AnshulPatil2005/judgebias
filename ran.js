// scrape_allahabad.js (Partial - Up to Case Type button click)
// Automates: Case Status -> Allahabad High Court (court+bench) -> Case Type tab click

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DOWNLOAD_BASE = path.resolve(__dirname, 'downloads');

const HUMAN_DELAY = 400;
const NAV_TIMEOUT = 45_000;
const SLOW_NET_WAIT = 2500;

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
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

const HIGH_COURT_OPTION_REGEX = /allahabad/i;
const BENCH_OPTION_REGEX = /\b(allahabad|lucknow)\b/i;

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
      let manualDispatch = false;
      await dropdown.selectOption(match.value).catch(async () => {
        await dropdown.selectOption({ label: match.text }).catch(async () => {
          await dropdown.evaluate((el, value) => {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, match.value);
          manualDispatch = true;
        });
      });
      if (!manualDispatch) {
        await dropdown.evaluate((el) => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }).catch(() => {});
      }
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

async function selectFirstSelectableOption(dropdown, label) {
  if (!dropdown) return false;
  try { await dropdown.scrollIntoViewIfNeeded().catch(() => {}); } catch {}

  const option = await dropdown.evaluate((el) => {
    const opts = Array.from(el.options || []);
    const candidate = opts.find((opt) => {
      const text = (opt.textContent || '').trim();
      const value = (opt.value || '').trim();
      if (opt.disabled) return false;
      if (!value && !text) return false;
      if (/select/i.test(text)) return false;
      return true;
    });
    if (!candidate) return null;
    return { value: candidate.value, text: (candidate.textContent || '').trim() };
  }).catch(() => null);

  if (!option) return false;

  let manualDispatch = false;
  await dropdown.selectOption(option.value).catch(async () => {
    await dropdown.selectOption({ label: option.text }).catch(async () => {
      await dropdown.evaluate((el, value) => {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, option.value);
      manualDispatch = true;
    });
  });
  if (!manualDispatch) {
    await dropdown.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(() => {});
  }

  const confirmed = await dropdown.evaluate((el, value, text) => {
    const opt = el.options?.[el.selectedIndex];
    if (!opt) return false;
    const selectedValue = String(opt.value || '').trim();
    const selectedText = (opt.textContent || '').trim();
    return selectedValue === value || selectedText === text;
  }, option.value, option.text).catch(() => false);

  if (confirmed) console.log(`${label}: selected "${option.text || option.value}"`);
  else console.warn(`${label}: fallback selection may not have stuck.`);

  return confirmed;
}

async function buildGenericScopes(scope) {
  const page = owningPage(scope);
  const scopes = [];
  const seen = new Set();
  const push = (candidate) => {
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      scopes.push(candidate);
    }
  };
  push(scope);
  push(page);
  try { push(await getFormScope(page)); } catch {}
  for (const frame of page.frames()) push(frame);
  return scopes;
}

async function selectHighCourt(scope) {
  const scopes = await buildGenericScopes(scope);
  return selectFromScopes(scopes, HIGH_COURT_SELECTOR_CANDIDATES, HIGH_COURT_OPTION_REGEX, 'High Court');
}

async function selectBench(scope) {
  const scopes = await buildGenericScopes(scope);
  const matchedScope = await selectFromScopes(scopes, BENCH_SELECTOR_CANDIDATES, BENCH_OPTION_REGEX, 'Bench');
  if (matchedScope) return matchedScope;

  const deadline = Date.now() + 8000;
  const joinedSelectors = BENCH_SELECTOR_CANDIDATES.join(', ');
  while (Date.now() < deadline) {
    for (const candidateScope of scopes) {
      const dropdown = candidateScope.locator(joinedSelectors).first();
      if (!(await dropdown.count())) continue;
      if (!await dropdown.isVisible().catch(() => false)) continue;
      const hasUsable = await dropdown.evaluate((el) => {
        return Array.from(el.options || []).some((opt) => {
          const text = (opt.textContent || '').trim();
          const value = (opt.value || '').trim();
          if (opt.disabled) return false;
          if (!value && !text) return false;
          return !/select/i.test(text);
        });
      }).catch(() => false);
      if (!hasUsable) continue;
      if (await selectFirstSelectableOption(dropdown, 'Bench')) return candidateScope;
    }
    await wait(200);
  }
  console.warn('Bench: unable to locate dropdown with usable options, please select manually.');
  return null;
}

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

  return clicked;
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

  // Click the "Case Type" tab/button
  const caseTypeTabClicked = await ensureCaseTypeTab(page);
  console.log(caseTypeTabClicked ? 'Case Type tab clicked successfully' : 'Case Type tab click may have failed');
  
  let formScope = await getFormScope(page);

  // Court & Bench selection
  let highCourtScope = formScope;
  const highCourtViaLabel = await selectByLabel(formScope, /high\s*court/i, /allahabad/i).catch(() => false);
  if (!highCourtViaLabel) {
    const selectedScope = await selectHighCourt(formScope);
    if (selectedScope) highCourtScope = selectedScope;
    else console.warn('High Court: selection helper did not find a matching dropdown.');
  }
  await wait(HUMAN_DELAY);
  
  const benchScope = await selectBench(highCourtScope);
  if (!benchScope) console.warn('Bench: selection helper did not find a matching dropdown.');
  await wait(HUMAN_DELAY);

  console.log('\nReached the point after Case Type button click.');
  console.log('Browser will remain open for inspection. Close manually when done.');
  
  // Keep browser open for inspection
  await new Promise(() => {});
})().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});