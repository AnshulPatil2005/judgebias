 // scrape_allahabad.js (Modified - Clicks sess_state_code after Case Type)
 // Automates: Case Status -> Case Type tab click -> Click sess_state_code -> Allahabad High Court (court+bench)
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
        return Array.from(el.options || []).some((opt) => regex.test(opt.textContent || '') || 
regex.test(opt.value || ''));
      }, matcherSource).catch(() => false);
      if (hasMatch) return true;
    }
    await wait(200);
  }
  return false;
 }
 
async function selectDropdownOption(scope, selectors, optionRegex, label) {
  const matcherSource = regexSource(optionMatcher);
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
  const matchedScope = await selectFromScopes(scopes, BENCH_SELECTOR_CANDIDATES, BENCH_OPTION_REGEX, 
'Bench');
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
 
async function clickAndSelectSessStateCode(page) {
  const scopes = [page, ...page.frames()];
  
  for (const scope of scopes) {
    const dropdown = scope.locator('select#sess_state_code').first();
    if (!(await dropdown.count())) continue;
    
    try {
      await dropdown.scrollIntoViewIfNeeded().catch(() => {});
      await dropdown.click({ timeout: 2000 });
      console.log('Successfully clicked select#sess_state_code');
      
      // Wait a moment for the dropdown to be ready
      await wait(500);
      
      // Select "Allahabad High Court"
      const match = await dropdown.evaluate((el) => {
        const regex = /allahabad/i;
        const opts = Array.from(el.options || []).map((opt) => ({
          text: (opt.textContent || '').trim(),
          value: opt.value,
        }));
        return opts.find((opt) => regex.test(opt.text) || regex.test(opt.value)) || null;
      });
      
      if (!match) {
        console.warn('Allahabad High Court option not found in sess_state_code dropdown');
        return false;
      }
      
      // Attempt to select the option
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
      
      console.log(`sess_state_code: selected "${match.text || match.value}"`);
      return true;
      
    } catch (e) {
      console.log('Attempting alternate method for sess_state_code...');
      try {
        await dropdown.dispatchEvent('click').catch(() => {});
        await dropdown.focus().catch(() => {});
        await wait(500);
        
        // Try selecting via evaluate
        const success = await dropdown.evaluate((el) => {
          const regex = /allahabad/i;
          const opts = Array.from(el.options || []);
          const match = opts.find((opt) => regex.test(opt.textContent || '') || regex.test(opt.value || 
''));
          if (match) {
            el.value = match.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          return false;
        });
        
        if (success) {
          console.log('Selected Allahabad High Court using alternate method');
          return true;
        }
      } catch {}
    }
  }
  
  console.warn('Unable to click and select in select#sess_state_code - element not found');
  return false;
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
 
// New function to click element with id "CScaseType"
 async function clickCScaseType(page) {
  console.log('Looking for element with id "CScaseType"...');
  await wait(1500); // Time gap before starting
  
  const scopes = [page, ...page.frames()];
  
  for (const scope of scopes) {
    const element = scope.locator('#CScaseType').first();
    if (await element.count() > 0 && await element.isVisible().catch(() => false)) {
      try {
        await element.scrollIntoViewIfNeeded().catch(() => {});
        await element.click({ timeout: 2000 });
        console.log('Successfully clicked element with id "CScaseType"');
        await wait(1000); // Time gap after click
        return true;
      } catch (e) {
        console.log('Click failed, trying alternative method...');
        try {
          await element.dispatchEvent('click');
          console.log('Dispatched click event to element');
          await wait(1000);
          return true;
        } catch (e2) {
          console.log('Dispatch also failed');
        }
      }
    }
  }
  
  console.warn('Could not find or click element with id "CScaseType"');
  return false;
 }
 
// New function to select radio button with id "radDCT"
 async function selectRadDCT(page) {
  console.log('Looking for radio button with id "radDCT"...');
  await wait(1200); // Time gap before selecting
  
  const scopes = [page, ...page.frames()];
  
  for (const scope of scopes) {
    const radioButton = scope.locator('#radDCT').first();
    if (await radioButton.count() > 0) {
      try {
        await radioButton.scrollIntoViewIfNeeded().catch(() => {});
        
        // Check if it's not already selected
        const isSelected = await radioButton.isChecked().catch(() => false);
        if (!isSelected) {
          await radioButton.click({ timeout: 2000 });
          console.log('Successfully selected radio button with id "radDCT"');
        } else {
          console.log('Radio button "radDCT" was already selected');
        }
        
        await wait(800); // Time gap after selecting
        return true;
      } catch (e) {
        console.log('Selection failed, trying alternative method...');
        try {
          await radioButton.evaluate((el) => {
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('click', { bubbles: true }));
          });
          console.log('Set radio button state via JavaScript');
          await wait(800);
          return true;
        } catch (e2) {
          console.log('Alternative method also failed');
        }
      }
    }
  }
  
  console.warn('Could not find or select radio button with id "radDCT"');
  return false;
 }
 
// New function to click input field and then input value "2018" in field with id "search_year"
 async function inputSearchYear(page) {
  console.log('Looking for input field with id "search_year"...');
  await wait(1300); // Time gap before starting
  
  const scopes = [page, ...page.frames()];
  
  for (const scope of scopes) {
    const inputField = scope.locator('#search_year').first();
    if (await inputField.count() > 0) {
      try {
        await inputField.scrollIntoViewIfNeeded().catch(() => {});
        
        // First click the input field to focus it
        await inputField.click({ timeout: 2000 });
        console.log('Successfully clicked input field with id "search_year"');
        await wait(500); // Short gap after click
        
        // Clear existing value and input 2018
        await inputField.fill('', { timeout: 1000 }).catch(() => {});
        await inputField.type('2018', { delay: 100, timeout: 2000 });
        console.log('Successfully entered "2018" in search_year field');
        
        await wait(900); // Time gap after input
        return true;
      } catch (e) {
        console.log('Input failed, trying alternative method...');
        try {
          await inputField.evaluate((el) => {
            el.focus();
            el.value = '2018';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          });
          console.log('Set input value via JavaScript with focus');
          await wait(900);
          return true;
        } catch (e2) {
          console.log('Alternative method also failed');
        }
      }
    }
  }
  
  console.warn('Could not find or input value in field with id "search_year"');
  return false;
 }
 
// New function to select from dropdown with id "case_type44"
 async function selectCaseType44(page) {
  console.log('Looking for select dropdown with id "case_type44"...');
  await wait(1200); // Time gap before selecting
  
  const scopes = [page, ...page.frames()];
  
  for (const scope of scopes) {
    const dropdown = scope.locator('#case_type44').first();
    if (await dropdown.count() > 0) {
      try {
        await dropdown.scrollIntoViewIfNeeded().catch(() => {});
        
        // Click the dropdown to open it
        await dropdown.click({ timeout: 2000 });
        console.log('Successfully clicked select dropdown with id "case_type44"');
        await wait(800); // Wait for dropdown to open
        
        // Select the first non-disabled, non-empty option
        const success = await selectFirstSelectableOption(dropdown, 'case_type44');
        if (success) {
          await wait(800); // Time gap after selection
          return true;
        }
      } catch (e) {
        console.log('Selection failed, trying alternative method...');
        try {
          // Alternative: select via JavaScript
          const selected = await dropdown.evaluate((el) => {
            const options = Array.from(el.options || []);
            const selectableOption = options.find(opt => 
              !opt.disabled && 
              opt.value && 
              !/select|choose/i.test(opt.textContent || '')
            );
            
            if (selectableOption) {
              el.value = selectableOption.value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { value: selectableOption.value, text: selectableOption.textContent };
            }
            return null;
          });
          
          if (selected) {
            console.log(`case_type44: selected "${selected.text || selected.value}" via JavaScript`);
            await wait(800);
            return true;
          }
        } catch (e2) {
          console.log('Alternative method also failed');
        }
      }
    }
  }
  
  console.warn('Could not find or select from dropdown with id "case_type44"');
  return false;
 }
 
// Function to wait for new page with #showList div
 
// Function to wait for new page with #showList div that's visible (display not none)
 async function waitForResultsPage(page) {
  console.log('\n⏳Waiting for you to complete CAPTCHA and click Go...');
  console.log('Monitoring for visible results page...');
  
  const startTime = Date.now();
  const maxWaitTime = 120000; // 2 minutes
  
  while (Date.now() - startTime < maxWaitTime) {
    // Check for #showList div in all scopes that's actually visible
    const scopes = [page, ...page.frames()];
    
    for (const scope of scopes) {
      const showListDiv = scope.locator('#showList').first();
      if (await showListDiv.count() > 0) {
        // Check if the div is actually visible (display not none)
        const isVisible = await showListDiv.isVisible().catch(() => false);
        if (isVisible) {
          console.log('✅Results page detected! Found #showList div that is visible');
          await wait(2000); // Wait for page to fully settle
          return true;
        } else {
          console.log('⏳#showList div exists but is hidden (display: none), waiting...');
        }
      }
    }
    
    await wait(3000); // Check every 3 seconds
    process.stdout.write(`\r
 ⏰
 Waiting for visible results... ${Math.floor((Date.now() - startTime) / 
1000)}s`);
  }
  
  console.log('\n⏰Timeout waiting for visible results page');
  return false;
 }
 // Function to click first element with class "someclass"
 async function clickFirstSomeClass(page) {
  console.log('Looking for first element with class "someclass"...');
  await wait(1500); // Time gap
  
  const scopes = [page, ...page.frames()];
  
  for (const scope of scopes) {
    const elements = scope.locator('.someclass');
    const count = await elements.count();
    
    if (count > 0) {
      try {
        const firstElement = elements.first();
        await firstElement.scrollIntoViewIfNeeded();
        await firstElement.click({ timeout: 3000 });
        console.log(`
 ✅
 Successfully clicked first .someclass element (${count} total found)`);
        await wait(1000);
        return true;
      } catch (e) {
        console.log('Click failed, trying alternative...');
        try {
          await firstElement.dispatchEvent('click');
          console.log('Dispatched click event to first .someclass element');
          await wait(1000);
          return true;
        } catch (e2) {
          console.log('Alternative method failed');
        }
      }
    }
  }
  
  console.warn('No elements with class "someclass" found');
  return false;
 }
 
// Function to download all PDFs from order_table - SIMPLIFIED VERSION
 async function downloadTablePDFs(page, context, viewButtonIndex = 1) {
  console.log(`Looking for PDFs in table with class "order_table" for View ${viewButtonIndex}...`);
  await wait(1500);
  
  try {
    const rows = page.locator('table.order_table tr');
    const rowCount = await rows.count();
    
    if (rowCount <= 1) {
      console.log('No data rows found in order_table');
      return false;
    }
 
    console.log(`Found ${rowCount - 1} PDFs to download`);
    
    let successCount = 0;
    
    for (let i = 1; i < rowCount; i++) {
      const row = rows.nth(i);
      const link = row.locator('a[href*="display_pdf.php"]').first();
      
      if (await link.count() > 0) {
        const relativeUrl = await link.getAttribute('href');
        const absoluteUrl = new URL(relativeUrl, page.url()).href;
        
        console.log(`Downloading PDF ${i}/${rowCount - 1}:`);
        
        try {
          // Use request context to download the PDF
          const response = await context.request.get(absoluteUrl);
          
          if (response.status() === 200) {
            const pdfBuffer = await response.body();
            // Create unique filename with view button index and PDF index
            const filename = `view_${viewButtonIndex}_pdf_${i}.pdf`;
            
            fs.writeFileSync(path.join(__dirname, filename), pdfBuffer);
            console.log(`
 ✅
 Saved: ${filename} (${pdfBuffer.length} bytes)`);
            successCount++;
          } else {
            console.log(`
 ❌
 PDF ${i}: HTTP ${response.status()} - ${response.statusText()}`);
          }
          
        } catch (error) {
          console.log(`
 ❌
 PDF ${i}: ${error.message}`);
        }
      }
      
      // Delay between downloads
      if (i < rowCount - 1) {
        await wait(1000);
      }
    }
    
    console.log(`
 📊
 View ${viewButtonIndex} summary: ${successCount}/${rowCount - 1} PDFs downloaded`);
    return successCount > 0;
    
  } catch (error) {
    console.log('Error processing order_table:', error.message);
    return false;
  }
 }
 
(async function run() {
  ensureDir(DOWNLOAD_BASE);
 
  const browser = await chromium.launch({ headless: false, args: ['--disable-blinkfeatures=AutomationControlled'] });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 850 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);
 
  // Global safety: auto-accept stray JS alerts
  page.on('dialog', async (d) => { try { await d.accept(); } catch {} });
 
  await page.goto('https://hcservices.ecourts.gov.in/hcservices/main.php#', { waitUntil: 
'domcontentloaded' });
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
  
  // Wait for a time gap after clicking Case Type
  await wait(1500);
  console.log('Waiting 1.5s after Case Type click...');
  
  // Click the sess_state_code selector
  await clickAndSelectSessStateCode(page);
  await wait(HUMAN_DELAY);
  
  let formScope = await getFormScope(page);
 
  // Court & Bench selection
  let highCourtScope = formScope;
  const highCourtViaLabel = await selectByLabel(formScope, /high\s*court/i, /allahabad/i).catch(() => 
false);
  if (!highCourtViaLabel) {
    const selectedScope = await selectHighCourt(formScope);
    if (selectedScope) highCourtScope = selectedScope;
    else console.warn('High Court: selection helper did not find a matching dropdown.');
  }
  await wait(HUMAN_DELAY);
  
  const benchScope = await selectBench(highCourtScope);
  if (!benchScope) console.warn('Bench: selection helper did not find a matching dropdown.');
  await wait(HUMAN_DELAY);
 
  console.log('\nCompleted court/bench selection. Now performing additional steps...');
 
  // NEW STEPS ADDED HERE:
  
  // 1. Click element with id "CScaseType"
  await clickCScaseType(page);
  
  // 2. Select radio button with id "radDCT"
  await selectRadDCT(page);
  
  // 3. Click input field and input value "2018" in field with id "search_year"
  await inputSearchYear(page);
  // 4. Select from dropdown with id "case_type44"
  await selectCaseType44(page);
 
  await waitForResultsPage(page);
 
  console.log('\n=== STARTING ITERATIVE PDF DOWNLOAD ===');
 
  // Find all "View" buttons with class "someclass" and process them one by one
  const viewButtons = page.locator('.someclass');
  const buttonCount = await viewButtons.count();
 
  console.log(`Found ${buttonCount} "View" buttons to process`);
 
  // Process only first few buttons for testing (remove this limit later)
  const maxButtonsToProcess = buttonCount; // Process only first 10 for testing
 
  for (let i = 0; i < maxButtonsToProcess; i++) {
    console.log(`\n=== Processing View Button ${i + 1}/${maxButtonsToProcess} ===`);
    
    try {
      // Re-locate buttons to avoid stale references
      const currentButtons = page.locator('.someclass');
      const currentButton = currentButtons.nth(i);
      
      if (await currentButton.count() > 0) {
        // Click the current "View" button
        await currentButton.scrollIntoViewIfNeeded();
        await currentButton.click({ timeout: 3000 });
        console.log(`
 ✅
 Clicked View button ${i + 1}`);
        
        // Wait for the details page to load
        await wait(3000);
        
        // Download PDFs from the order_table on this page
        const downloaded = await downloadTablePDFs(page, context, i + 1);
        
        if (downloaded) {
          console.log(`
 ✅
 Completed PDF downloads for View button ${i + 1}`);
        } else {
          console.log(`
 ⚠
 No PDFs downloaded for View button ${i + 1}`);
        }
        
        // Click back button to return to main results page
        console.log('Returning to results page...');
        const backButton = page.locator('#bckbtn').first();
        if (await backButton.count() > 0) {
          await backButton.click({ timeout: 2000 });
          console.log('✅Clicked back button');
          
          // Wait briefly for page to stabilize (NO waitForResultsPage needed)
          await wait(2000);
        } else {
          console.log('❌Back button not found, trying browser back');
          await page.goBack();
          await wait(2000);
        }
        
      } else {
        console.log(`
 ❌
 View button ${i + 1} not found, skipping`);
      }
      
    } catch (error) {
      console.log(`
 ❌
 Error processing View button ${i + 1}: ${error.message}`);
      
      // Try to recover by going back
      try {
        await page.goBack();
        await wait(2000);
      } catch (e) {
        console.log('Could not recover navigation');
      }
    }
    
    // Delay before next iteration
    if (i < maxButtonsToProcess - 1) {
      await wait(1500);
    }
  }
 
  console.log(`\n
 🎉
 Completed processing ${maxButtonsToProcess} View buttons!`);
 
  console.log('\nAll steps completed successfully!');
  console.log('Browser will remain open for inspection. Close manually when done.');
  
  // Keep browser open for inspection
  await new Promise(() => {});
 })().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
 });
