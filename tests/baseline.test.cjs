const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createChannel } = require('../channel/server.cjs');
const { visibleRows, exportVisible } = require('../capture/visible.cjs');
const { Ledger } = require('../capture/ledger.cjs');
const { sourceRow, sameSource } = require('../capture/identity.cjs');

test('source row identity includes region independently of display text', () => {
  const row = sourceRow({ source_id: 'a', region: 'east', edition: 'v1', title: ' 归途 ' });
  assert.equal(row.title, '归途');
  assert.equal(sameSource(row, { ...row, region: 'west' }), false);
  assert.throws(() => sourceRow({ ...row, edition: '' }), /edition/);
});

test('visible export is durable and only covers the viewport', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viewport-'));
  const channel = createChannel();
  try {
    const url = await channel.start();
    const filename = path.join(directory, 'rows.json');
    const ledger = new Ledger(filename);
    await exportVisible(url, ledger);
    assert.equal(ledger.rows.length, 2);
    assert.equal(channel.state.regions.east.length, 3);
    assert.equal(new Ledger(filename).rows.length, 2);
  } finally { await channel.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('scroll reuses a DOM node with another source identity', async () => {
  const channel = createChannel();
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const url = await channel.start();
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForSelector('article[data-id]');
    await page.locator('article').first().evaluate(element => element.dataset.marker = 'same-node');
    await page.locator('#viewport').evaluate(element => element.scrollTop = 90);
    await page.waitForFunction(() => document.querySelector('#rows').dataset.offset === '1');
    const rows = await visibleRows(page);
    assert.equal(rows[0].source_id, 'east-b');
    assert.equal(await page.locator('article').first().getAttribute('data-marker'), 'same-node');
    await page.locator('#region').selectOption('west');
    await page.waitForFunction(() => document.querySelector('article').dataset.id === 'west-a');
    await page.locator('article button').first().click();
    await page.waitForFunction(() => document.querySelector('#detail').textContent.includes('wa-1'));
    assert.equal((await visibleRows(page))[0].region, 'west');
  } finally { await browser.close(); await channel.close(); }
});

test('edition invalidation is an explicit protocol result', async () => {
  const channel = createChannel();
  try {
    const url = await channel.start();
    channel.state.expired.add('edition-1');
    const reply = await fetch(url + '/api/list?edition=edition-1&region=east');
    assert.equal(reply.status, 410);
    assert.equal((await reply.json()).error, 'edition_expired');
  } finally { await channel.close(); }
});

test('ledger keeps separate source identities despite identical titles', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  try {
    const ledger = new Ledger(path.join(directory, 'rows.json'));
    const row = { source_id: 'one', title: '归途', region: 'east', edition: 'edition-1' };
    ledger.importRows([row, { ...row, source_id: 'two' }]);
    ledger.importRows([row]);
    assert.equal(ledger.rows.length, 2);
    assert.throws(() => ledger.importRows([{ title: 'missing identity' }]), /provenance/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
