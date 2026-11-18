const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChannel } = require('./channel/server.cjs');
const { Ledger } = require('./capture/ledger.cjs');
const { exportVisible } = require('./capture/visible.cjs');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-'));
  const channel = createChannel();
  try {
    const url = await channel.start();
    const ledger = new Ledger(path.join(directory, 'rows.json'));
    await exportVisible(url, ledger);
    console.log(JSON.stringify({ visible: ledger.rows, sourceTotal: channel.state.regions.east.length }));
  } finally { await channel.close(); fs.rmSync(directory, { force: true, recursive: true }); }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
