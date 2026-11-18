function sourceRow(row) {
  for (const field of ['source_id', 'region', 'edition', 'title']) {
    if (typeof row[field] !== 'string' || !row[field].trim()) throw new Error(`source row has no ${field}`);
  }
  return { source_id: row.source_id, region: row.region, edition: row.edition, title: row.title.trim() };
}

function sameSource(left, right) {
  return left.region === right.region && left.source_id === right.source_id;
}

module.exports = { sourceRow, sameSource };
