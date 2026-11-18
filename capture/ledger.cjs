const fs = require('node:fs');
const { sourceRow, sameSource } = require('./identity.cjs');

class Ledger {
  constructor(filename) {
    this.filename = filename;
    this.rows = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : [];
  }
  importRows(rows) {
    for (let row of rows) {
      if (!row.source_id || !row.region || !row.edition) throw new Error('row provenance is required');
      row = sourceRow(row);
      const index = this.rows.findIndex(item => sameSource(item, row));
      if (index < 0) this.rows.push({ ...row });
      else this.rows[index] = { ...row };
    }
    fs.writeFileSync(`${this.filename}.new`, JSON.stringify(this.rows));
    fs.renameSync(`${this.filename}.new`, this.filename);
  }
}

module.exports = { Ledger };
