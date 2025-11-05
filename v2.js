// scrape_allahabad.js (Modified - With Excel Export)
// Automates: Case Status -> Case Type tab click -> Click sess_state_code -> Allahabad High Court (court+bench)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

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
      
      await wait(500);
      
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

async function clickCScaseType(page) {
  console.log('Looking for element with id "CScaseType"...');
  await wait(1500);
  
  const scopes = [page, ...page.frames()];
  
  for (const scope of scopes) {
    const element = scope.locator('#CScaseType').first();
    if (await element.count() > 0 && await element.isVisible().catch(() => false)) {
      try {
        await element.scrollIntoViewIfNeeded().catch(() => {});
        await element.click({ timeout: 2000 });
        console.log('Successfully clicked element with id "CScaseType"');
        await wait(1000);
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

async function selectRadDCT(page) {
  console.log('Looking for radio button with id "radDCT"...');
  await wait(1200);
  
  const scopes = [page, ...page.frames()];
  
  for (const scope of scopes) {
    const radioButton = scope.locator('#radDCT').first();
    if (await radioButton.count() > 0) {
      try {
        await radioButton.scrollIntoViewIfNeeded().catch(() => {});
        
        const isSelected = await radioButton.isChecked().catch(() => false);
        if (!isSelected) {
          await radioButton.click({ timeout: 2000 });
          console.log('Successfully selected radio button with id "radDCT"');
        } else {
          console.log('Radio button "radDCT" was already selected');
        }
        
        await wait(800);
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

async function inputSearchYear(page) {
  console.log('Looking for input field with id "search_year"...');
  await wait(1300);
  
  const scopes = [page, ...page.frames()];
  
  for (const scope of scopes) {
    const inputField = scope.locator('#search_year').first();
    if (await inputField.count() > 0) {
      try {
        await inputField.scrollIntoViewIfNeeded().catch(() => {});
        
        await inputField.click({ timeout: 2000 });
        console.log('Successfully clicked input field with id "search_year"');
        await wait(500);
        
        await inputField.fill('', { timeout: 1000 }).catch(() => {});
        await inputField.type('2018', { delay: 100, timeout: 2000 });
        console.log('Successfully entered "2018" in search_year field');
        
        await wait(900);
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

async function selectCaseType44(page) {
  console.log('Looking for select dropdown with id "case_type44"...');
  await wait(1200);
  
  const scopes = [page, ...page.frames()];
  
  for (const scope of scopes) {
    const dropdown = scope.locator('#case_type44').first();
    if (await dropdown.count() > 0) {
      try {
        await dropdown.scrollIntoViewIfNeeded().catch(() => {});
        
        await dropdown.click({ timeout: 2000 });
        console.log('Successfully clicked select dropdown with id "case_type44"');
        await wait(800);
        
        const success = await selectFirstSelectableOption(dropdown, 'case_type44');
        if (success) {
          await wait(800);
          return true;
        }
      } catch (e) {
        console.log('Selection failed, trying alternative method...');
        try {
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

async function waitForResultsPage(page) {
  console.log('\n⏳Waiting for you to complete CAPTCHA and click Go...');
  console.log('Monitoring for visible results page...');
  
  const startTime = Date.now();
  const maxWaitTime = 120000;
  
  while (Date.now() - startTime < maxWaitTime) {
    const scopes = [page, ...page.frames()];
    
    for (const scope of scopes) {
      const showListDiv = scope.locator('#showList').first();
      if (await showListDiv.count() > 0) {
        const isVisible = await showListDiv.isVisible().catch(() => false);
        if (isVisible) {
          console.log('✅Results page detected! Found #showList div that is visible');
          await wait(2000);
          return true;
        } else {
          console.log('⏳#showList div exists but is hidden (display: none), waiting...');
        }
      }
    }
    
    await wait(3000);
    process.stdout.write(`\r⏰Waiting for visible results... ${Math.floor((Date.now() - startTime) / 1000)}s`);
  }
  
  console.log('\n⏰Timeout waiting for visible results page');
  return false;
}

// NEW FUNCTION: Extract case details from the page
async function extractCaseDetails(page) {
  console.log('Extracting case details...');
  await wait(1000);
  
  const scopes = [page, ...page.frames()];
  let caseData = {};
  
  for (const scope of scopes) {
    try {
      caseData = await scope.evaluate(() => {
        const data = {};
        
        // Helper function to get table cell value by label
        const getTableValue = (labelText) => {
          const cells = Array.from(document.querySelectorAll('td'));
          const labelCell = cells.find(cell => cell.textContent.trim() === labelText);
          if (labelCell && labelCell.nextElementSibling) {
            return labelCell.nextElementSibling.textContent.trim();
          }
          return '';
        };
        
        // Extract Case Details section
        data.filingNumber = getTableValue('Filing Number');
        data.filingDate = getTableValue('Filing Date');
        data.registrationNumber = getTableValue('Registration Number');
        data.registrationDate = getTableValue('Registration Date');
        data.cnrNumber = getTableValue('CNR Number');
        
        // Extract Case Status section
        data.firstHearingDate = getTableValue('First Hearing Date');
        data.decisionDate = getTableValue('Decision Date');
        data.caseStatus = getTableValue('Case Status');
        data.natureOfDisposal = getTableValue('Nature of Disposal');
        data.coram = getTableValue('Coram');
        data.benchType = getTableValue('Bench Type');
        data.judicialBranch = getTableValue('Judicial Branch');
        data.state = getTableValue('State');
        data.district = getTableValue('District');
        
        // Extract Petitioner and Advocate
        const allCells = Array.from(document.querySelectorAll('td'));
        const petitionerHeader = allCells.find(el => /Petitioner and Advocate/i.test(el.textContent));
        if (petitionerHeader) {
          const table = petitionerHeader.closest('table');
          if (table) {
            const rows = Array.from(table.querySelectorAll('tr'));
            let petitioners = [];
            let inPetitionerSection = false;
            for (let row of rows) {
              const text = row.textContent.trim();
              if (/Petitioner and Advocate/i.test(text)) {
                inPetitionerSection = true;
                continue;
              }
              if (/Respondent and Advocate/i.test(text)) {
                break;
              }
              if (inPetitionerSection && text && text.length > 0) {
                // Get advocate info from the row
                const advocateCell = row.querySelector('td:last-child');
                if (advocateCell) {
                  const advocateText = advocateCell.textContent.trim();
                  if (advocateText && !advocateText.includes('Advocate-')) {
                    petitioners.push(text.replace(/\s+/g, ' '));
                  }
                }
              }
            }
            data.petitionerAndAdvocate = petitioners.join('; ');
          }
        } else {
          data.petitionerAndAdvocate = '';
        }
        
        // Extract Respondent and Advocate
        const respondentHeader = allCells.find(el => /Respondent and Advocate/i.test(el.textContent));
        if (respondentHeader) {
          const table = respondentHeader.closest('table');
          if (table) {
            const rows = Array.from(table.querySelectorAll('tr'));
            let respondents = [];
            let inRespondentSection = false;
            for (let row of rows) {
              const text = row.textContent.trim();
              if (/Respondent and Advocate/i.test(text)) {
                inRespondentSection = true;
                continue;
              }
              if (/Acts/i.test(text) || /Category/i.test(text)) {
                break;
              }
              if (inRespondentSection && text && text.length > 0) {
                respondents.push(text.replace(/\s+/g, ' '));
              }
            }
            data.respondentAndAdvocate = respondents.join('; ');
          }
        } else {
          data.respondentAndAdvocate = '';
        }
        
        // Extract Acts
        data.underActs = getTableValue('Under Act(s)');
        data.underSections = getTableValue('Under Section(s)');
        
        // Extract Category Details
        data.category = getTableValue('Category');
        data.subCategory = getTableValue('Sub Category');
        
        // Extract IA Details from IA Details table
        const iaDetailsHeader = allCells.find(el => /IA Details/i.test(el.textContent));
        let iaDetails = [];
        if (iaDetailsHeader) {
          const table = iaDetailsHeader.closest('table')?.nextElementSibling;
          if (table && table.tagName === 'TABLE') {
            const rows = Array.from(table.querySelectorAll('tr'));
            for (let i = 1; i < rows.length; i++) {
              const cells = rows[i].querySelectorAll('td');
              if (cells.length >= 4) {
                const iaNumber = cells[0]?.textContent.trim() || '';
                const party = cells[1]?.textContent.trim() || '';
                const dateOfFiling = cells[2]?.textContent.trim() || '';
                const iaStatus = cells[3]?.textContent.trim() || '';
                
                if (iaNumber || party) {
                  iaDetails.push({
                    iaNumber,
                    party,
                    dateOfFiling,
                    iaStatus
                  });
                }
              }
            }
          }
        }
        data.iaDetails = iaDetails.length > 0 ? JSON.stringify(iaDetails) : '';
        
        return data;
      });
      
      if (Object.keys(caseData).length > 0) {
        console.log('✅Successfully extracted case details');
        console.log('Sample data:', JSON.stringify(caseData).substring(0, 200) + '...');
        return caseData;
      }
    } catch (e) {
      console.log('Error extracting from scope:', e.message);
    }
  }
  
  console.warn('⚠️Could not extract case details');
  return caseData;
}

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
          const response = await context.request.get(absoluteUrl);
          
          if (response.status() === 200) {
            const pdfBuffer = await response.body();
            const filename = `view_${viewButtonIndex}_pdf_${i}.pdf`;
            
            fs.writeFileSync(path.join(__dirname, filename), pdfBuffer);
            console.log(`✅Saved: ${filename} (${pdfBuffer.length} bytes)`);
            successCount++;
          } else {
            console.log(`❌PDF ${i}: HTTP ${response.status()} - ${response.statusText()}`);
          }
          
        } catch (error) {
          console.log(`❌PDF ${i}: ${error.message}`);
        }
      }
      
      if (i < rowCount - 1) {
        await wait(1000);
      }
    }
    
    console.log(`📊View ${viewButtonIndex} summary: ${successCount}/${rowCount - 1} PDFs downloaded`);
    return successCount > 0;
    
  } catch (error) {
    console.log('Error processing order_table:', error.message);
    return false;
  }
}

// NEW FUNCTION: Save case data to Excel
function saveCaseDataToExcel(allCaseData, filename = 'case_details.xlsx') {
  console.log('\n📊Creating Excel file with case details...');
  
  try {
    // Create workbook
    const wb = XLSX.utils.book_new();
    
    // Convert data to worksheet format
    const ws = XLSX.utils.json_to_sheet(allCaseData);
    
    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, 'Case Details');
    
    // Write to file
    XLSX.writeFile(wb, filename);
    
    console.log(`✅Excel file created: ${filename}`);
    console.log(`📝Total cases recorded: ${allCaseData.length}`);
    return true;
  } catch (error) {
    console.log('❌Error creating Excel file:', error.message);
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

  page.on('dialog', async (d) => { try { await d.accept(); } catch {} });

  // Array to store all case data
  const allCaseData = [];
  
  // Handle Ctrl+C gracefully to save Excel before exit
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Received interrupt signal. Saving data and exiting...');
    if (allCaseData.length > 0) {
      saveCaseDataToExcel(allCaseData, 'case_details_partial.xlsx');
      console.log(`✅ Saved ${allCaseData.length} cases to case_details_partial.xlsx`);
    }
    process.exit(0);
  });

  await page.goto('https://hcservices.ecourts.gov.in/hcservices/main.php#', { waitUntil: 'domcontentloaded' });
  await wait(SLOW_NET_WAIT);

  const caseStatusLink = page.getByRole('link', { name: /case status/i }).or(page.getByText(/case status/i));
  await Promise.race([
    (async () => {
      const dialog = await page.waitForEvent('dialog', { timeout: 15000 }).catch(() => null);
      if (dialog) { console.log('Popup:', dialog.message()); await dialog.accept(); }
    })(),
    (async () => { await caseStatusLink.first().click().catch(() => {}); })()
  ]);
  const late = await page.waitForEvent('dialog', { timeout: 2000 }).catch(() => null);
  if (late) { console.log('Late popup:', late.message()); await late.accept(); }
  await dismissVisibleOk(page).catch(() => {});

  await page.waitForLoadState('domcontentloaded');
  await wait(SLOW_NET_WAIT);

  const caseTypeTabClicked = await ensureCaseTypeTab(page);
  console.log(caseTypeTabClicked ? 'Case Type tab clicked successfully' : 'Case Type tab click may have failed');
  
  await wait(1500);
  console.log('Waiting 1.5s after Case Type click...');
  
  await clickAndSelectSessStateCode(page);
  await wait(HUMAN_DELAY);
  
  let formScope = await getFormScope(page);

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

  console.log('\nCompleted court/bench selection. Now performing additional steps...');

  await clickCScaseType(page);
  await selectRadDCT(page);
  await inputSearchYear(page);
  await selectCaseType44(page);

  await waitForResultsPage(page);

  console.log('\n=== STARTING ITERATIVE PDF DOWNLOAD & DATA EXTRACTION ===');

  const viewButtons = page.locator('.someclass');
  const buttonCount = await viewButtons.count();

  console.log(`Found ${buttonCount} "View" buttons to process`);
  
  // CHANGE THIS NUMBER to process fewer cases for testing
  // Set to 50 for testing, or change to buttonCount to process all
  const maxButtonsToProcess = Math.min(50, buttonCount); // Process only first 50
  
  console.log(`⚠️ NOTE: Processing only first ${maxButtonsToProcess} cases. Press Ctrl+C anytime to save and exit.`);

  for (let i = 0; i < maxButtonsToProcess; i++) {
    console.log(`\n=== Processing View Button ${i + 1}/${maxButtonsToProcess} ===`);
    
    try {
      const currentButtons = page.locator('.someclass');
      const currentButton = currentButtons.nth(i);
      
      if (await currentButton.count() > 0) {
        await currentButton.scrollIntoViewIfNeeded();
        await currentButton.click({ timeout: 3000 });
        console.log(`✅Clicked View button ${i + 1}`);
        
        await wait(3000);
        
        // Extract case details from the page
        const caseDetails = await extractCaseDetails(page);
        
        if (Object.keys(caseDetails).length > 0) {
          // Add view button index to the data
          caseDetails.viewButtonIndex = i + 1;
          allCaseData.push(caseDetails);
          console.log(`✅Case details extracted for View ${i + 1}`);
        } else {
          console.log(`⚠️No case details extracted for View ${i + 1}`);
        }
        
        // Download PDFs from the order_table on this page
        const downloaded = await downloadTablePDFs(page, context, i + 1);
        
        if (downloaded) {
          console.log(`✅Completed PDF downloads for View button ${i + 1}`);
        } else {
          console.log(`⚠️No PDFs downloaded for View button ${i + 1}`);
        }
        
        console.log('Returning to results page...');
        const backButton = page.locator('#bckbtn').first();
        if (await backButton.count() > 0) {
          await backButton.click({ timeout: 2000 });
          console.log('✅Clicked back button');
          await wait(2000);
        } else {
          console.log('❌Back button not found, trying browser back');
          await page.goBack();
          await wait(2000);
        }
        
      } else {
        console.log(`❌View button ${i + 1} not found, skipping`);
      }
      
    } catch (error) {
      console.log(`❌Error processing View button ${i + 1}: ${error.message}`);
      
      try {
        await page.goBack();
        await wait(2000);
      } catch (e) {
        console.log('Could not recover navigation');
      }
    }
    
    if (i < maxButtonsToProcess - 1) {
      await wait(1500);
    }
  }

  console.log(`\n🎉Completed processing ${maxButtonsToProcess} View buttons!`);
  
  // Debug: Log the collected data
  console.log(`\n📊Total cases collected: ${allCaseData.length}`);
  if (allCaseData.length > 0) {
    console.log('Sample of first case data:');
    console.log(JSON.stringify(allCaseData[0], null, 2));
  }
  
  // Save all case data to Excel
  if (allCaseData.length > 0) {
    saveCaseDataToExcel(allCaseData, 'case_details.xlsx');
  } else {
    console.log('⚠️No case data to save to Excel');
  }

  console.log('\nAll steps completed successfully!');
  console.log('Browser will remain open for inspection. Close manually when done.');
  
  await new Promise(() => {});
})().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});