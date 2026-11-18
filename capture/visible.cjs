const { chromium } = require('playwright');
const { sourceRow } = require('./identity.cjs');

async function visibleRows(page) {
  const rows = await page.locator('#rows article:visible').evaluateAll(elements => elements.map(element => ({
    source_id: element.dataset.id, title: element.querySelector('span').textContent,
    region: element.dataset.region, edition: element.dataset.edition,
  })));
  return rows.map(sourceRow);
}

async function exportVisible(url, ledger) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForSelector('#rows article[data-id]');
    const rows = await visibleRows(page);
    ledger.importRows(rows);
    return rows;
  } finally { await browser.close(); }
}

module.exports = { visibleRows, exportVisible };
