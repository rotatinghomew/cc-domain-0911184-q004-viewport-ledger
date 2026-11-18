const http = require('node:http');

function createChannel() {
  const state = {
    edition: 'edition-1', expired: new Set(), delay: 0,
    regions: {
      east: [{ id: 'east-a', title: '归途', episodes: [{ id: 'ea-1', number: 1 }, { id: 'ea-2', number: 2 }] }, { id: 'east-b', title: '灯火', episodes: [{ id: 'eb-1', number: 1 }] }, { id: 'east-c', title: '归途', episodes: [{ id: 'ec-1', number: 1 }] }],
      west: [{ id: 'west-a', title: '归途', episodes: [{ id: 'wa-1', number: 1 }] }],
    },
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html lang="zh"><title>渠道剧集</title><h1>分集状态</h1>
      <label>地区<select id="region"><option value="east">华东</option><option value="west">西部</option></select></label>
      <p id="edition"></p><div id="viewport" style="height:160px;overflow:auto;border:1px solid"><div style="height:1200px;position:relative"><section id="rows" style="position:sticky;top:0"></section></div></div>
      <pre id="detail"></pre><p id="status"></p><script>
      let edition='',region='east',total=0;const rows=document.querySelector('#rows');
      for(let n=0;n<2;n++){let node=document.createElement('article');node.innerHTML='<span></span><button>展开</button>';rows.append(node);}
      async function render(){const offset=Math.min(Math.floor(document.querySelector('#viewport').scrollTop/80),Math.max(0,total-2));
      const result=await fetch('/api/list?'+new URLSearchParams({edition,region,offset}));const body=await result.json();
      if(!result.ok){document.querySelector('#status').textContent=body.error;return;}edition=body.edition;total=body.total;
      document.querySelector('#edition').textContent=edition;rows.dataset.total=total;rows.dataset.offset=offset;
      [...rows.children].forEach((node,n)=>{const item=body.items[n];node.hidden=!item;if(!item)return;node.dataset.id=item.id;node.dataset.region=region;node.dataset.edition=edition;node.querySelector('span').textContent=item.title;
      node.querySelector('button').onclick=async()=>{const result=await fetch('/api/episodes?'+new URLSearchParams({edition,region,id:item.id}));const data=await result.json();document.querySelector('#detail').textContent=JSON.stringify(data);};});}
      document.querySelector('#viewport').onscroll=()=>render();document.querySelector('#region').onchange=()=>{region=document.querySelector('#region').value;document.querySelector('#viewport').scrollTop=0;render();};render();
      </script></html>`);
      return;
    }
    const edition = url.searchParams.get('edition') || state.edition;
    const region = url.searchParams.get('region') || 'east';
    const send = (status, payload) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)); };
    if (state.expired.has(edition) || edition !== state.edition) { send(410, { error: 'edition_expired', edition }); return; }
    if (!state.regions[region]) { send(404, { error: 'unknown_region' }); return; }
    if (url.pathname === '/api/list') {
      const offset = Number(url.searchParams.get('offset') || 0);
      send(200, { edition, region, total: state.regions[region].length,
        items: state.regions[region].slice(offset, offset + 2).map(({ episodes, ...series }) => series) });
    } else if (url.pathname === '/api/episodes') {
      const series = state.regions[region].find(item => item.id === url.searchParams.get('id'));
      if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
      if (!series) send(404, { error: 'unknown_series' });
      else send(200, { edition, region, series: series.id, episodes: series.episodes });
    } else send(404, { error: 'not_found' });
  });
  return { state,
    async start() { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; },
    async close() { await new Promise(resolve => server.close(resolve)); },
  };
}

module.exports = { createChannel };
