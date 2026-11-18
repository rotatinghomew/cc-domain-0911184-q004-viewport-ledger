const fs = require('node:fs');
const { sourceRow, sameSource, episodeRow, sameEpisode } = require('./identity.cjs');

class Ledger {
  constructor(filename) {
    this.filename = filename;
    if (!fs.existsSync(filename)) {
      this.seriesRows = [];
      this.episodeRows = [];
      return;
    }
    const stored = JSON.parse(fs.readFileSync(filename, 'utf8'));
    // 兼容只保存作品行数组的旧持久化格式，旧数据不会因为结构升级而丢失。
    if (Array.isArray(stored)) {
      this.seriesRows = stored;
      this.episodeRows = [];
    } else {
      this.seriesRows = Array.isArray(stored.seriesRows) ? stored.seriesRows : [];
      this.episodeRows = Array.isArray(stored.episodeRows) ? stored.episodeRows : [];
    }
  }

  // 旧调用方读取 rows 的方式继续可用。
  get rows() { return this.seriesRows; }

  persist() {
    fs.writeFileSync(`${this.filename}.new`, JSON.stringify({ seriesRows: this.seriesRows, episodeRows: this.episodeRows }));
    fs.renameSync(`${this.filename}.new`, this.filename);
  }

  importRows(rows) {
    for (let row of rows) {
      if (!row.source_id || !row.region || !row.edition) throw new Error('row provenance is required');
      row = sourceRow(row);
      const index = this.seriesRows.findIndex(item => sameSource(item, row));
      if (index < 0) this.seriesRows.push({ ...row });
      else this.seriesRows[index] = { ...row };
    }
    this.persist();
  }

  importEpisodes(rows) {
    for (let row of rows) {
      if (!row.series_id || !row.episode_id || !row.region || !row.edition) {
        throw new Error('episode provenance is required');
      }
      row = episodeRow(row);
      const index = this.episodeRows.findIndex(item => sameEpisode(item, row));
      if (index < 0) this.episodeRows.push({ ...row });
      // DOM 节点复用/重复点击会再次给出同一源分集：身份相同只更新确认版次，绝不重复入库。
      else this.episodeRows[index] = { ...row };
    }
    this.persist();
  }
}

module.exports = { Ledger };
