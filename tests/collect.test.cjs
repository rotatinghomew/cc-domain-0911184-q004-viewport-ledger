const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createChannel } = require('../channel/server.cjs');
const { Ledger } = require('../capture/ledger.cjs');
const {
  episodeRow, sameEpisode, verifyEpisodePayload, sourceRow,
} = require('../capture/identity.cjs');
const {
  collectRegions, collectRegion, pinEdition, openPage,
  EditionExpiredError, PageLoadError,
} = require('../capture/collect.cjs');

function tempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function episodeCount(channel, region) {
  return channel.state.regions[region].reduce((sum, series) => sum + series.episodes.length, 0);
}

test('full collection covers every region and episode through real page interaction', async () => {
  const channel = createChannel();
  const tmp = tempDir('collect-full-');
  try {
    const url = await channel.start();
    const ledger = new Ledger(path.join(tmp.directory, 'ledger.json'));
    const report = await collectRegions(url, ['east', 'west'], ledger);

    assert.equal(report.status, 'complete');
    assert.equal(report.edition, 'edition-1');
    const east = report.regions.find(item => item.region === 'east');
    const west = report.regions.find(item => item.region === 'west');
    assert.equal(east.collectedSeries, 3);
    assert.equal(west.collectedSeries, 1);
    assert.equal(east.totalEpisodes, episodeCount(channel, 'east'));
    assert.equal(west.totalEpisodes, episodeCount(channel, 'west'));
    assert.deepEqual(east.series.map(item => item.source_id).sort(), ['east-a', 'east-b', 'east-c']);

    // 同名作品“归途”在华东有两条不同来源记录，相同文字不能合并成分集。
    const homecomings = east.series.filter(item => item.title === '归途');
    assert.equal(homecomings.length, 2);
    const episodeIds = ledger.episodeRows.map(row => row.episode_id).sort();
    assert.deepEqual(episodeIds, ['ea-1', 'ea-2', 'eb-1', 'ec-1', 'wa-1']);
    // 每条记录都带得出处：地区与确认它的页面版次。
    assert.ok(ledger.episodeRows.every(row => row.region && row.edition === 'edition-1'));
    assert.ok(ledger.seriesRows.every(row => row.edition === 'edition-1'));

    // 持久化使用新结构，重新打开后数据仍在。
    const reopened = new Ledger(path.join(tmp.directory, 'ledger.json'));
    assert.equal(reopened.episodeRows.length, 5);
    assert.equal(reopened.seriesRows.length, 4);
    assert.equal(reopened.rows.length, 4); // 旧的 rows 访问方式仍可用
  } finally {
    await channel.close();
    tmp.cleanup();
  }
});

test('rerunning collection with reused DOM nodes does not duplicate records', async () => {
  const channel = createChannel();
  const tmp = tempDir('collect-rerun-');
  try {
    const url = await channel.start();
    const ledger = new Ledger(path.join(tmp.directory, 'ledger.json'));
    await collectRegions(url, ['east'], ledger);
    const first = ledger.episodeRows.length;
    assert.ok(first > 0);
    await collectRegions(url, ['east'], ledger);
    assert.equal(ledger.episodeRows.length, first);
    assert.equal(ledger.seriesRows.length, 3);
  } finally {
    await channel.close();
    tmp.cleanup();
  }
});

test('a late expand response from another region is rejected and never attached to the new filter', async () => {
  const channel = createChannel();
  // 让华东的展开响应足够慢，确保地区切换后它才到达。
  channel.state.delay = 250;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const url = await channel.start();
    const page = await openPage(browser, url);
    const edition = await pinEdition(page);

    await page.locator('#region').selectOption('east');
    await page.waitForFunction(() => document.querySelector('article').dataset.id === 'east-a');
    await page.locator('article button').first().click(); // 华东展开请求在途
    await page.locator('#region').selectOption('west');
    await page.waitForFunction(() => document.querySelector('article').dataset.id === 'west-a');
    await page.waitForFunction(() => {
      const text = document.querySelector('#detail').textContent;
      return text.length > 0 && JSON.parse(text).region === 'east';
    });

    // 迟到的华东响应到达后，对西部作品的真实展开仍只接受西部 provenance。
    const report = await collectRegion(page, 'west', edition);
    assert.equal(report.status, 'complete');
    assert.deepEqual(report.series[0].episodes.map(row => row.episode_id), ['wa-1']);
    assert.ok(report.series[0].episodes.every(row => row.region === 'west'));
  } finally {
    await browser.close();
    await channel.close();
  }
});

test('edition invalidation mid-collection leaves the round incomplete without mixing editions', async () => {
  const channel = createChannel();
  const tmp = tempDir('collect-expired-');
  try {
    const url = await channel.start();
    const ledger = new Ledger(path.join(tmp.directory, 'ledger.json'));
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    let page;
    try {
      page = await openPage(browser, url);
      const edition = await pinEdition(page);

      // 已在旧版次下确认一个作品及其分集。
      const east = await collectRegion(page, 'east', edition);
      assert.equal(east.status, 'complete');
      ledger.importRows(east.series.map(({ source_id, region, edition: e, title }) => ({
        source_id, region, edition: e, title,
      })));
      ledger.importEpisodes(east.series.flatMap(item => item.episodes));

      // 采集期间有人修改归属，固定版次失效；对西部的下一次列表请求得到 410。
      channel.state.expired.add('edition-1');
      const listResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/list');
      await page.locator('#region').selectOption('west');
      await listResponsePromise;
      await assert.rejects(
        () => collectRegion(page, 'west', edition),
        error => error instanceof EditionExpiredError,
      );
    } finally {
      await browser.close();
    }

    // 不能把两个版次的分集拼成“完整”结果：只有旧版次下确认过的记录，且出处仍标明旧版次。
    assert.ok(ledger.episodeRows.length > 0);
    assert.ok(ledger.episodeRows.every(row => row.edition === 'edition-1'));
    assert.ok(ledger.seriesRows.every(row => row.edition === 'edition-1'));

    // 完整流程则在报告层面显式反映未完成与需要补采的地区：
    // 失效可能在固定版次前（页面初始列表即 410）或后续交互中暴露，两种都不算完整结果。
    const episodeCountBefore = ledger.episodeRows.length;
    const report = await collectRegions(url, ['east'], ledger).catch(error => ({
      status: 'incomplete',
      failureReason: error.failureReason || 'collection_error',
      regions: [],
    }));
    assert.equal(report.status, 'incomplete');
    assert.equal(report.failureReason, 'edition_expired');
    if (report.regions.length) assert.equal(report.regions[0].status, 'incomplete');
    // 失效后没有任何新版次记录混入。
    assert.equal(ledger.episodeRows.length, episodeCountBefore);
    assert.ok(ledger.episodeRows.every(row => row.edition === 'edition-1'));
  } finally {
    await channel.close();
    tmp.cleanup();
  }
});

test('pinned edition binds every list and expand request; rollover returns 410 through the page', async () => {
  const channel = createChannel();
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const url = await channel.start();
    const page = await openPage(browser, url);
    const edition = await pinEdition(page);
    assert.equal(edition, 'edition-1');
    assert.equal(await page.locator('#pin-state').getAttribute('data-pinned'), 'edition-1');

    const [request] = await Promise.all([
      page.waitForRequest(request => new URL(request.url()).pathname === '/api/list'),
      page.locator('#viewport').evaluate(element => { element.scrollTop = 90; }),
    ]);
    assert.equal(new URL(request.url()).searchParams.get('edition'), 'edition-1');
    await page.waitForFunction(() => document.querySelector('#rows').dataset.offset === '1');

    // 版次切换后，沿用旧固定版次的下一次页面请求按协议得到 410，页面自身也展示失效状态。
    channel.state.edition = 'edition-2';
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/list'),
      page.locator('#viewport').evaluate(element => { element.scrollTop = 0; }),
    ]);
    assert.equal(response.status(), 410);
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('edition_expired'));
  } finally {
    await browser.close();
    await channel.close();
  }
});

test('a stalled page interaction is reported as needing recapture rather than partial completeness', async () => {
  const channel = createChannel();
  channel.state.delay = 2000;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const url = await channel.start();
    const page = await openPage(browser, url, 300);
    const edition = await pinEdition(page, 300);
    await assert.rejects(
      () => collectRegion(page, 'east', edition, 300),
      error => error instanceof PageLoadError && error.failureReason === 'page_load_timeout',
    );
  } finally {
    await browser.close();
    await channel.close();
  }
});

test('episode identity keeps same-number episodes from different sources and dedupes repeats', () => {
  const row = episodeRow({ series_id: 'east-a', episode_id: 'ea-1', region: 'east', edition: 'e1', number: 1 });
  assert.equal(row.number, 1);
  // 不同来源、相同集序号是不同分集。
  assert.equal(sameEpisode(row, { ...row, episode_id: 'ec-1' }), false);
  assert.equal(sameEpisode(row, { ...row, region: 'west' }), false);
  assert.throws(() => episodeRow({ ...row, episode_id: '' }), /episode_id/);
  assert.throws(() => episodeRow({ ...row, number: '1' }), /number/);

  // provenance 不匹配的展开负载一律拒绝。
  const expected = sourceRow({ source_id: 'east-a', region: 'east', edition: 'e1', title: '归途' });
  const payload = { edition: 'e1', region: 'east', series: 'east-a', episodes: [] };
  assert.ok(verifyEpisodePayload(payload, expected));
  assert.equal(verifyEpisodePayload({ ...payload, region: 'west' }, expected), null);
  assert.equal(verifyEpisodePayload({ ...payload, edition: 'e0' }, expected), null);
  assert.equal(verifyEpisodePayload({ ...payload, series: 'east-b' }, expected), null);
  assert.equal(verifyEpisodePayload(null, expected), null);
});

test('ledger migrates legacy row arrays and stores episode provenance separately', () => {
  const tmp = tempDir('collect-ledger-');
  try {
    const legacy = path.join(tmp.directory, 'legacy.json');
    fs.writeFileSync(legacy, JSON.stringify([
      { source_id: 'east-a', region: 'east', edition: 'edition-1', title: '归途' },
    ]));
    const ledger = new Ledger(legacy);
    assert.equal(ledger.rows.length, 1);
    ledger.importEpisodes([
      { series_id: 'east-a', episode_id: 'ea-1', region: 'east', edition: 'edition-1', number: 1 },
    ]);
    const reopened = new Ledger(legacy);
    assert.equal(reopened.rows.length, 1);
    assert.equal(reopened.episodeRows.length, 1);
    assert.throws(
      () => ledger.importEpisodes([{ series_id: 'east-a', region: 'east', edition: 'x' }]),
      /provenance/,
    );
  } finally {
    tmp.cleanup();
  }
});
