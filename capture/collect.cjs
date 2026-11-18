const { chromium } = require('playwright');
const { verifyEpisodePayload } = require('./identity.cjs');

const DEFAULT_TIMEOUT = 10000;
const MAX_EXPAND_ATTEMPTS = 4;

class EditionExpiredError extends Error {
  constructor(edition) {
    super(`edition ${edition} expired during collection`);
    this.name = 'EditionExpiredError';
    this.failureReason = 'edition_expired';
  }
}

class PageLoadError extends Error {
  constructor(detail) {
    super(`page interaction did not finish in time: ${detail}`);
    this.name = 'PageLoadError';
    this.failureReason = 'page_load_timeout';
  }
}

// 页面加载/交互超时统一归一化：这类缺口需要补采，不能被当成部分完整结果。
async function withPageTimeout(label, timeout, action) {
  try {
    return await action();
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.failureReason === 'page_load_timeout')) {
      throw new PageLoadError(label);
    }
    throw error;
  }
}

function isListResponse(response) {
  return new URL(response.url()).pathname === '/api/list';
}

function isEpisodeResponse(response) {
  return new URL(response.url()).pathname === '/api/episodes';
}

function isPinResponse(response) {
  return new URL(response.url()).pathname === '/api/pin';
}

function escapeAttribute(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

async function openPage(browser, url, timeout = DEFAULT_TIMEOUT) {
  const page = await browser.newPage();
  await withPageTimeout('navigation', timeout, () => page.goto(url, { waitUntil: 'domcontentloaded', timeout }));
  try {
    await withPageTimeout('initial list', timeout, () => page.waitForSelector('#rows article[data-id]', { timeout }));
  } catch (error) {
    // 初始列表就拿到 410 时，页面不会渲染任何作品行；显式识别为版次失效而非笼统加载超时。
    const status = await page.locator('#status').textContent().catch(() => '');
    if (status && status.includes('edition_expired')) throw new EditionExpiredError('initial render');
    throw error;
  }
  return page;
}

// 通过页面上的真实按钮固定本轮版次；之后所有请求都由页面携带该版次。
// 固定结果以页面 DOM 状态为准，绝不采用失效后响应体里可能出现的新版次。
async function pinEdition(page, timeout = DEFAULT_TIMEOUT) {
  await withPageTimeout('pin edition', timeout, async () => {
    const responsePromise = page.waitForResponse(isPinResponse, { timeout });
    await page.locator('#pin').click({ timeout });
    const response = await responsePromise;
    if (!response.ok()) throw new PageLoadError('pin request failed');
    await page.waitForFunction(
      () => document.querySelector('#pin-state').dataset.pinned !== '',
      null,
      { timeout },
    );
  });
  return page.locator('#pin-state').getAttribute('data-pinned');
}

async function readVisibleRows(page) {
  return page.locator('#rows article:visible').evaluateAll(elements => elements
    .filter(element => element.dataset.id)
    .map(element => ({
      source_id: element.dataset.id,
      region: element.dataset.region,
      edition: element.dataset.edition,
      title: element.querySelector('span').textContent,
    })));
}

async function assertFreshList(response, region, edition) {
  if (response.status() === 410) throw new EditionExpiredError(edition);
  const body = await response.json();
  if (body.region !== region || body.edition !== edition) throw new EditionExpiredError(edition);
  return body;
}

// 操作真实的地区下拉，并等待属于当前地区/版次的列表响应；410 即本轮失效。
async function switchRegion(page, region, edition, timeout = DEFAULT_TIMEOUT) {
  return withPageTimeout(`region switch ${region}`, timeout, async () => {
    const responsePromise = page.waitForResponse(isListResponse, { timeout });
    await page.locator('#region').selectOption(region, { timeout });
    const body = await assertFreshList(await responsePromise, region, edition);
    await page.waitForFunction(
      expected => document.querySelector('#rows article[data-id]')
        && document.querySelector('#rows article[data-id]').dataset.region === expected,
      region,
      { timeout },
    );
    return body;
  });
}

async function scrollToOffset(page, offset, region, edition, timeout = DEFAULT_TIMEOUT) {
  return withPageTimeout(`scroll to offset ${offset}`, timeout, async () => {
    const responsePromise = page.waitForResponse(isListResponse, { timeout });
    await page.locator('#viewport').evaluate((element, value) => { element.scrollTop = value * 80; }, offset);
    const body = await assertFreshList(await responsePromise, region, edition);
    await page.waitForFunction(
      value => document.querySelector('#rows').dataset.offset === String(value),
      offset,
      { timeout },
    );
    return body;
  });
}

// 只信任点击后由页面真实发出、且 provenance 与当前作品/地区/固定版次一致的响应。
// 迟到的旧地区或旧版次响应会被拒绝并重新点击展开，绝不挂到新筛选的作品下。
async function expandSeries(page, item, timeout = DEFAULT_TIMEOUT) {
  return withPageTimeout(`expand ${item.source_id}`, timeout, async () => {
    for (let attempt = 0; attempt < MAX_EXPAND_ATTEMPTS; attempt += 1) {
      // 每次尝试重新解析定位器：重试之间列表可能重渲染，旧按钮节点会被虚拟列表复用。
      const button = page.locator(`#rows article[data-id="${escapeAttribute(item.source_id)}"] button`);
      const responsePromise = page.waitForResponse(isEpisodeResponse, { timeout });
      await button.click({ timeout });
      const response = await responsePromise;
      if (response.status() === 410) throw new EditionExpiredError(item.edition);
      const verified = verifyEpisodePayload(await response.json(), item);
      if (!verified) continue;
      return verified.episodes.map(episode => ({
        series_id: item.source_id,
        episode_id: episode.id,
        region: item.region,
        edition: item.edition,
        number: episode.number,
      }));
    }
    return null;
  });
}

// 滚动遍历整个虚拟列表（而不是把当前屏幕当成全部），逐作品展开并校验分集。
async function collectRegion(page, region, edition, timeout = DEFAULT_TIMEOUT) {
  const current = await page.locator('#region').inputValue({ timeout });
  let body;
  if (current !== region) {
    body = await switchRegion(page, region, edition, timeout);
  } else {
    body = {
      total: Number(await page.locator('#rows').getAttribute('data-total', { timeout })),
      edition,
      region,
    };
  }

  const pageSize = await page.locator('#rows article').count();
  const total = body.total;
  const seen = new Map();
  const seriesReports = [];
  const missingSeries = [];
  const lastOffset = Math.max(0, total - pageSize);

  for (let offset = 0; offset <= lastOffset; offset += 1) {
    if (offset > 0) await scrollToOffset(page, offset, region, edition, timeout);
    const visible = await readVisibleRows(page);
    for (const item of visible) {
      if (item.region !== region || item.edition !== edition) {
        throw new EditionExpiredError(edition);
      }
      if (seen.has(item.source_id)) continue; // 复用的 DOM 节点：同一源作品不重复展开、不重复入库
      seen.set(item.source_id, true);
      const episodes = await expandSeries(page, item, timeout);
      if (episodes === null) {
        missingSeries.push({ source_id: item.source_id, reason: 'stale_expand_response' });
        continue;
      }
      seriesReports.push({
        source_id: item.source_id,
        title: item.title,
        region: item.region,
        edition: item.edition,
        totalEpisodes: episodes.length,
        episodes,
      });
    }
  }

  if (seen.size !== total) {
    // 虚拟列表未把全部源作品渲染出来：明确标记缺口，不把已采部分宣称为完整地区。
    missingSeries.push({ reason: 'series_missing_after_scroll', expected: total, collected: seen.size });
  }

  return {
    region,
    edition,
    status: missingSeries.length ? 'incomplete' : 'complete',
    totalSeries: total,
    collectedSeries: seen.size,
    totalEpisodes: seriesReports.reduce((sum, item) => sum + item.totalEpisodes, 0),
    series: seriesReports,
    missingSeries,
    failureReason: missingSeries.length ? missingSeries[0].reason : null,
  };
}

function unfinishedRegion(region, failureReason) {
  return {
    region,
    status: 'incomplete',
    totalSeries: 0,
    collectedSeries: 0,
    totalEpisodes: 0,
    series: [],
    missingSeries: [],
    failureReason,
  };
}

// 按运营选择的地区列表取得完整分集清单，并给出哪些地区/作品真实采全、哪些需要补采。
async function collectRegions(url, regions, ledger, options = {}) {
  const timeout = options.timeout || DEFAULT_TIMEOUT;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const report = { edition: null, status: 'complete', failureReason: null, regions: [] };
  try {
    const page = await openPage(browser, url, timeout);
    const edition = await pinEdition(page, timeout);
    report.edition = edition;

    for (let index = 0; index < regions.length; index += 1) {
      const region = regions[index];
      try {
        const regionReport = await collectRegion(page, region, edition, timeout);
        ledger.importRows(regionReport.series.map(({ source_id, region: r, edition: e, title }) => ({
          source_id, region: r, edition: e, title,
        })));
        ledger.importEpisodes(regionReport.series.flatMap(item => item.episodes));
        report.regions.push(regionReport);
        if (regionReport.status !== 'complete') {
          report.status = 'incomplete';
          report.failureReason = report.failureReason || regionReport.failureReason;
        }
      } catch (error) {
        report.status = 'incomplete';
        report.failureReason = error.failureReason || 'collection_error';
        report.regions.push(unfinishedRegion(region, error.failureReason || 'collection_error'));
        for (const remaining of regions.slice(index + 1)) {
          report.regions.push(unfinishedRegion(remaining, 'not_collected'));
        }
        break;
      }
    }
    return report;
  } finally {
    await browser.close();
  }
}

module.exports = {
  DEFAULT_TIMEOUT,
  EditionExpiredError,
  PageLoadError,
  openPage,
  pinEdition,
  readVisibleRows,
  switchRegion,
  scrollToOffset,
  expandSeries,
  collectRegion,
  collectRegions,
};
