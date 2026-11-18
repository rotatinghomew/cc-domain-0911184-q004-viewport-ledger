const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChannel } = require('./channel/server.cjs');
const { Ledger } = require('./capture/ledger.cjs');
const { exportVisible } = require('./capture/visible.cjs');
const { collectRegions } = require('./capture/collect.cjs');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-'));
  const channel = createChannel();
  try {
    const url = await channel.start();
    const ledger = new Ledger(path.join(directory, 'ledger.json'));

    // 单次可见区域导出的既有使用方式保持不变，只声明屏幕内作品行。
    await exportVisible(url, ledger);
    const visible = ledger.rows.length;

    // 按运营选择的地区滚动采全虚拟列表，并展开每个作品的分集。
    const report = await collectRegions(url, ['east', 'west'], ledger);
    console.log(JSON.stringify({
      report,
      visibleSeriesRows: visible,
      storedSeries: ledger.seriesRows.length,
      storedEpisodes: ledger.episodeRows.length,
      sourceTotals: Object.fromEntries(
        Object.entries(channel.state.regions).map(([region, series]) => [
          region,
          { series: series.length, episodes: series.reduce((sum, item) => sum + item.episodes.length, 0) },
        ]),
      ),
    }, null, 2));
  } finally { await channel.close(); fs.rmSync(directory, { force: true, recursive: true }); }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
