function requireString(row, field) {
  if (typeof row[field] !== 'string' || !row[field].trim()) throw new Error(`source row has no ${field}`);
}

function sourceRow(row) {
  for (const field of ['source_id', 'region', 'edition', 'title']) requireString(row, field);
  return { source_id: row.source_id, region: row.region, edition: row.edition, title: row.title.trim() };
}

function sameSource(left, right) {
  return left.region === right.region && left.source_id === right.source_id;
}

// 展开后的分集记录：地区与作品源身份是前提，分集自身的源 ID 才是最终身份。
// 同样的集序号/文案、不同的 episode_id 必须保留为不同记录。
function episodeRow(row) {
  for (const field of ['series_id', 'episode_id', 'region', 'edition']) requireString(row, field);
  if (typeof row.number !== 'number' || !Number.isFinite(row.number)) {
    throw new Error('episode row has no numeric episode number');
  }
  return {
    series_id: row.series_id,
    episode_id: row.episode_id,
    region: row.region,
    edition: row.edition,
    number: row.number,
  };
}

function sameEpisode(left, right) {
  return left.region === right.region
    && left.series_id === right.series_id
    && left.episode_id === right.episode_id;
}

// 展开响应必须自带 provenance，且与本轮固定版次、当前筛选地区、被点击作品完全一致，
// 否则就是迟到的旧地区/旧版次响应，不能挂到当前作品下。
function verifyEpisodePayload(data, expected) {
  if (!data || typeof data !== 'object') return null;
  if (data.edition !== expected.edition || data.region !== expected.region || data.series !== expected.source_id) {
    return null;
  }
  if (!Array.isArray(data.episodes)) return null;
  return data;
}

module.exports = { sourceRow, sameSource, episodeRow, sameEpisode, verifyEpisodePayload };
