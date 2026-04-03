/**
 * app.js
 * ------
 * Main application entry point.
 */

'use strict';

// ── GLOBALS ───────────────────────────────────────────────────────────────────
let rawGraph = null;
window._nodeById = new Map();
window.rawGraph  = null;

const DATA_URL = './data/anime-graph.json';

// ── DEFAULTS ──────────────────────────────────────────────────────────────────
const DEFAULTS = {
  types:          ['TV','MOVIE','OVA','ONA','SPECIAL','UNKNOWN'],
  releaseStatuses:['FINISHED','RELEASING','NOT_YET_RELEASED','CANCELLED','HIATUS','UNKNOWN'],
  nodeTypes:      ['anime','studio','genre'],
  yearFrom:  1917, yearTo:   2030,
  epMin:     0,    epMax:    9999,
  lenMin:    0,    lenMax:   999999,
  scoreMin:  0,    scoreMax: 10,
  colorBy:   'node_type',
  nodeSizeBy:'default',
  search:    '',
  selTags: [], selGenres: [], selStudios: [],
  username: '',
  listStatuses: ['COMPLETED','PLANNING','CURRENT','PAUSED','DROPPED','REPEATING','RELATED'],
  minClusterSize: 1,
  mode: 'all',
};

// ── LOADER ────────────────────────────────────────────────────────────────────
function setProgress(pct, msg) {
  document.getElementById('loader-bar').style.width = pct + '%';
  if (msg) document.getElementById('loader-msg').textContent = msg;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(id));
}

async function loadDatabase() {
  setProgress(0,  'Initialising graph engine…');
  initGraph();
  setProgress(5,  'Fetching anime graph database…');

  let res;
  try {
    res = await fetchWithTimeout(DATA_URL, 60000);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' — is data/anime-graph.json committed?');
  } catch (e) { throw new Error(e.message); }

  setProgress(15, 'Downloading…');
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '', received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text     += decoder.decode(value, { stream: true });
    received += value?.length || 0;
    setProgress(Math.min(50, 15 + (received / 12e6) * 35),
      'Downloading… ' + (received / 1048576).toFixed(1) + ' MB');
    await new Promise(r => setTimeout(r, 0));
  }

  setProgress(55, 'Parsing JSON…');
  await new Promise(r => setTimeout(r, 0));
  rawGraph = JSON.parse(text);
  window.rawGraph = rawGraph;

  setProgress(65, 'Building node index…');
  await new Promise(r => setTimeout(r, 0));
  rawGraph.nodes.forEach(n => window._nodeById.set(n.node_id, n));

  document.getElementById('stat-total').textContent =
    (rawGraph.meta?.total_anime ?? rawGraph.nodes.filter(n => n.type === 'anime').length).toLocaleString();

  setProgress(75, 'Building filter lists…');
  populateFilterLists();

  setProgress(82, 'Restoring filter state…');
  await restoreFromUrl();

  setProgress(95, 'Rendering initial graph…');
  applyFiltersAndRender();
  setProgress(100, 'Ready!');

  setTimeout(() => {
    document.getElementById('loader').classList.add('fade-out');
    document.getElementById('app').style.display = 'flex';
    setTimeout(() => document.getElementById('loader').style.display = 'none', 900);
  }, 400);
}

// ── POPULATE FILTER DROPDOWNS ─────────────────────────────────────────────────
function populateFilterLists() {
  const studios = [], tags = [], genres = [];

  rawGraph.nodes.forEach(n => {
    switch (n.type) {
      case 'studio': studios.push(n.name); break;
      case 'genre':  genres.push(n.name);  break;
      case 'tag': {
        // If this tag is a genre, put it in genres; otherwise in tags
        const genreTags = window.GENRE_TAGS || new Set();
        if (genreTags.has(n.name)) genres.push(n.name);
        else tags.push(n.name);
        break;
      }
    }
  });

  studios.sort(); tags.sort(); genres.sort();
  fillSelect('studio-select', studios);
  fillSelect('tag-select',    tags);
  fillSelect('genre-select',  genres);

  wireSearch('studio-search', 'studio-select');
  wireSearch('tag-search',    'tag-select');
  wireSearch('genre-search',  'genre-select');

  wireClear('studio-clear', 'studio-select');
  wireClear('tag-clear',    'tag-select');
  wireClear('genre-clear',  'genre-select');
}

function fillSelect(id, items) {
  const sel = document.getElementById(id);
  if (!sel) return;
  items.forEach(name => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = name;
    sel.appendChild(opt);
  });
}

function wireSearch(inputId, selectId) {
  const input = document.getElementById(inputId);
  const sel   = document.getElementById(selectId);
  if (!input || !sel) return;
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    [...sel.options].forEach(o => { o.style.display = o.value.toLowerCase().includes(q) ? '' : 'none'; });
  });
}

function wireClear(clearId, selectId) {
  const el  = document.getElementById(clearId);
  const sel = document.getElementById(selectId);
  if (!el || !sel) return;
  el.onclick = () => { [...sel.options].forEach(o => o.selected = false); };
}

// ── MAIN RENDER LOOP ──────────────────────────────────────────────────────────
function applyFiltersAndRender() {
  if (!rawGraph) return;
  const filters = getFilters();
  const result  = buildGraphData(rawGraph, filters, window._nodeById);

  // Store for stat-only recalculation (cluster size filter)
  window._lastGraphNodes = result.nodes;
  window._lastGraphLinks = result.links;

  renderGraph(result);
  buildLegend(result.filteredAnime, filters.colorBy, filters.visibleNodeTypes, result.visibleMeta, result.highlightedAnime);

  const totalVisible = result.filteredAnime.length + (result.highlightedAnime?.length || 0);
  const modeLabel = filters.mode === 'user' && window.userListLoaded
    ? `My List (${totalVisible.toLocaleString()})`
    : `All Anime (${totalVisible.toLocaleString()})`;
  document.querySelector('#mode-pill span').textContent = modeLabel;

  clearTimeout(window._urlTimer);
  window._urlTimer = setTimeout(saveToUrl, 300);
}

// ── ANILIST DEBUG DOWNLOAD ────────────────────────────────────────────────────
function downloadAnilistDebug() {
  if (!window.userListLoaded) {
    alert('No AniList list loaded. Please fetch a username first.');
    return;
  }
  const debug = {
    username: document.getElementById('username-input')?.value?.trim() || '(unknown)',
    fetched_at: new Date().toISOString(),
    userScores: window.userScores || {},
    userList: {},
    userList_RELATED_count: window.userList?.RELATED?.size || 0,
  };
  // Serialize each status set to array of al_ids
  const STATUSES = ['COMPLETED','PLANNING','CURRENT','PAUSED','DROPPED','REPEATING','RELATED'];
  STATUSES.forEach(s => {
    debug.userList[s] = [...(window.userList?.[s] || [])];
  });

  // Annotate with titles from rawGraph if available
  const alIdToTitle = new Map();
  if (window.rawGraph) {
    window.rawGraph.nodes.forEach(n => {
      if (n.type === 'anime') alIdToTitle.set(n.al_id, n.title || n.title_en || String(n.al_id));
    });
  }
  debug.annotated = {};
  STATUSES.forEach(s => {
    debug.annotated[s] = debug.userList[s].map(id => ({
      al_id: id,
      title: alIdToTitle.get(id) || '(not in DB)',
      score: (window.userScores || {})[id] ?? null,
    }));
  });

  const blob = new Blob([JSON.stringify(debug, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `anilist-debug-${debug.username}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
function downloadVisibleAnimeList() {
  if (!rawGraph) return;
  const filters = getFilters();
  const result  = buildGraphData(rawGraph, filters, window._nodeById);
  const allAnime = [...result.filteredAnime, ...(result.highlightedAnime || [])];
  if (!allAnime.length) { alert('No anime currently visible.'); return; }

  const lines = allAnime
    .map(a => `${a.title_en || a.title || '?'}${a.year ? ` (${a.year})` : ''}`)
    .sort();

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'anigraph-list.txt'; a.click();
  URL.revokeObjectURL(url);
}

// ── URL STATE ─────────────────────────────────────────────────────────────────
function saveToUrl() {
  try {
    const s = {};
    const ct = [...document.querySelectorAll('#type-checkboxes input:checked')].map(i=>i.value);
    if (ct.length !== DEFAULTS.types.length) s.t = ct.join(',');

    const vt = [...document.querySelectorAll('#node-type-visibility input:checked')].map(i=>i.value);
    if (JSON.stringify([...vt].sort()) !== JSON.stringify([...DEFAULTS.nodeTypes].sort())) s.nt = vt.join(',');

    const yf=parseInt(document.getElementById('year-from').value);
    const yt=parseInt(document.getElementById('year-to').value);
    if(yf!==DEFAULTS.yearFrom) s.yf=yf;
    if(yt!==DEFAULTS.yearTo)   s.yt=yt;

    const ef=parseInt(document.getElementById('ep-min').value);
    const et=parseInt(document.getElementById('ep-max').value);
    if(ef!==DEFAULTS.epMin) s.ef=ef;
    if(et!==DEFAULTS.epMax) s.et=et;

    const lf=parseFloat(document.getElementById('len-min').value);
    const lt=parseFloat(document.getElementById('len-max').value);
    if(lf!==DEFAULTS.lenMin) s.lf=lf;
    if(lt!==DEFAULTS.lenMax) s.lt=lt;

    const smn=parseFloat(document.getElementById('score-min').value);
    const smx=parseFloat(document.getElementById('score-max').value);
    if(smn!==DEFAULTS.scoreMin) s.smn=smn;
    if(smx!==DEFAULTS.scoreMax) s.smx=smx;

    const cb=document.querySelector('input[name="colorby"]:checked')?.value;
    if(cb&&cb!==DEFAULTS.colorBy) s.cb=cb;
    const nsb=document.querySelector('input[name="nodeSizeBy"]:checked')?.value;
    if(nsb&&nsb!==DEFAULTS.nodeSizeBy) s.nsb=nsb;

    const q=document.getElementById('search-input').value.trim();
    if(q) s.q=q;

    const tg=[...document.getElementById('tag-select').selectedOptions].map(o=>o.value);
    const gn=[...document.getElementById('genre-select').selectedOptions].map(o=>o.value);
    const st=[...document.getElementById('studio-select').selectedOptions].map(o=>o.value);
    if(tg.length) s.tg=tg.join('|');
    if(gn.length) s.gn=gn.join('|');
    if(st.length) s.st=st.join('|');

    const mc=parseInt(document.getElementById('min-cluster-size')?.value)||1;
    if(mc!==DEFAULTS.minClusterSize) s.mc=mc;

    const md=document.getElementById('mode-select')?.value||'all';
    if(md!==DEFAULTS.mode) s.md=md;

    const u=document.getElementById('username-input').value.trim();
    if(u) {
      s.u=u;
      const ls=[...document.querySelectorAll('#list-status-checkboxes input:checked')].map(i=>i.value);
      if(ls.length!==DEFAULTS.listStatuses.length) s.ls=ls.join(',');
    }

    history.replaceState(null,'',Object.keys(s).length?'#'+new URLSearchParams(s).toString():'#');
  } catch(_) {}
}

async function restoreFromUrl() {
  const hash = window.location.hash.slice(1);
  if (!hash) return;
  try {
    const p = new URLSearchParams(hash);
    if(p.has('t')) { const v=new Set(p.get('t').split(',')); document.querySelectorAll('#type-checkboxes input').forEach(i=>{i.checked=v.has(i.value);}); }
    if(p.has('nt')){ const v=new Set(p.get('nt').split(',')); document.querySelectorAll('#node-type-visibility input').forEach(i=>{i.checked=v.has(i.value);}); }
    if(p.has('yf')) document.getElementById('year-from').value=p.get('yf');
    if(p.has('yt')) document.getElementById('year-to').value=p.get('yt');
    if(p.has('ef')) document.getElementById('ep-min').value=p.get('ef');
    if(p.has('et')) document.getElementById('ep-max').value=p.get('et');
    if(p.has('lf')) document.getElementById('len-min').value=p.get('lf');
    if(p.has('lt')) document.getElementById('len-max').value=p.get('lt');
    if(p.has('smn')) document.getElementById('score-min').value=p.get('smn');
    if(p.has('smx')) document.getElementById('score-max').value=p.get('smx');
    if(p.has('mc')) document.getElementById('min-cluster-size').value=p.get('mc');
    if(p.has('cb')) { const r=document.querySelector('input[name="colorby"][value="'+p.get('cb')+'"]'); if(r) r.checked=true; }
    if(p.has('nsb')){ const r=document.querySelector('input[name="nodeSizeBy"][value="'+p.get('nsb')+'"]'); if(r) r.checked=true; }
    if(p.has('q')) document.getElementById('search-input').value=p.get('q');
    if(p.has('md')) { const s=document.getElementById('mode-select'); if(s) s.value=p.get('md'); }

    const rs=(id,raw)=>{
      if(!raw) return;
      const v=new Set(raw.split('|'));
      const s=document.getElementById(id);
      if(s) [...s.options].forEach(o=>{o.selected=v.has(o.value);});
    };
    rs('tag-select',p.get('tg'));
    rs('genre-select',p.get('gn'));
    rs('studio-select',p.get('st'));

    if(p.has('u')) {
      document.getElementById('username-input').value=p.get('u');
      if(p.has('ls')){ const v=new Set(p.get('ls').split(',')); document.querySelectorAll('#list-status-checkboxes input').forEach(i=>{i.checked=v.has(i.value);}); }
      await fetchUserList();
      if(p.has('cb')){ const r=document.querySelector('input[name="colorby"][value="'+p.get('cb')+'"]'); if(r) r.checked=true; }
    }
  } catch(e) { console.warn('URL restore failed:',e); }
}

// ── SHARE ─────────────────────────────────────────────────────────────────────
function copyShareLink() {
  saveToUrl();
  const url = window.location.href;
  const fb = () => {
    const ta = document.createElement('textarea');
    ta.value = url; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    showShareToast('Link copied!');
  };
  navigator.clipboard ? navigator.clipboard.writeText(url).then(()=>showShareToast('Link copied!')).catch(fb) : fb();
}

function showShareToast(msg) {
  let t = document.getElementById('share-toast');
  if (!t) { t=document.createElement('div'); t.id='share-toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('visible');
  clearTimeout(t._timer); t._timer = setTimeout(()=>t.classList.remove('visible'), 2200);
}

// ── CLEAR ALL FILTERS ─────────────────────────────────────────────────────────
function clearAllFilters() {
  document.querySelectorAll('#type-checkboxes input').forEach(i=>i.checked=true);
  document.querySelectorAll('#release-status-checkboxes input').forEach(i=>i.checked=true);
  // document.querySelectorAll('#country-checkboxes input').forEach(i=>i.checked=true);  // commented out

  const defNT = new Set(DEFAULTS.nodeTypes);
  document.querySelectorAll('#node-type-visibility input').forEach(i=>{i.checked=defNT.has(i.value);});

  document.getElementById('year-from').value  = DEFAULTS.yearFrom;
  document.getElementById('year-to').value    = DEFAULTS.yearTo;
  document.getElementById('ep-min').value     = DEFAULTS.epMin;
  document.getElementById('ep-max').value     = DEFAULTS.epMax;
  document.getElementById('len-min').value    = DEFAULTS.lenMin;
  document.getElementById('len-max').value    = DEFAULTS.lenMax;
  document.getElementById('score-min').value  = DEFAULTS.scoreMin;
  document.getElementById('score-max').value  = DEFAULTS.scoreMax;
  document.getElementById('min-cluster-size').value = DEFAULTS.minClusterSize;

  document.querySelector('input[name="colorby"][value="node_type"]').checked  = true;
  document.querySelector('input[name="nodeSizeBy"][value="default"]').checked = true;
  document.getElementById('search-input').value = '';

  ['tag-select','genre-select','studio-select'].forEach(id=>{
    const sel=document.getElementById(id);
    if(sel) [...sel.options].forEach(o=>o.selected=false);
  });

  document.querySelectorAll('.highlight-toggle input').forEach(i=>i.checked=false);

  const ms=document.getElementById('mode-select');
  if(ms) ms.value='all';

  history.replaceState(null,'',window.location.pathname+window.location.search);
  applyFiltersAndRender();
}

// ── COLLAPSIBLE SECTIONS ──────────────────────────────────────────────────────
function initCollapsibleSections() {
  document.querySelectorAll('.section-header').forEach(header => {
    const body = document.getElementById('section-body-' + header.dataset.section);
    const icon = header.querySelector('.collapse-icon');
    if (!body) return;
    header.addEventListener('click', () => {
      const collapsed = body.classList.toggle('collapsed');
      if (icon) icon.textContent = collapsed ? '▸' : '▾';
    });
  });
}

// ── EVENT WIRING ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[name="colorby"]').forEach(r=>r.addEventListener('change', applyFiltersAndRender));
  document.querySelectorAll('input[name="nodeSizeBy"]').forEach(r=>r.addEventListener('change', applyFiltersAndRender));
  document.getElementById('node-type-visibility').addEventListener('change', applyFiltersAndRender);
  document.getElementById('search-input').addEventListener('input', () => {
    clearTimeout(window._searchTimer);
    window._searchTimer = setTimeout(applyFiltersAndRender, 400);
  });
  document.querySelectorAll('.section-apply-btn').forEach(btn=>btn.addEventListener('click', applyFiltersAndRender));
  document.getElementById('clear-all-btn')?.addEventListener('click', clearAllFilters);
  document.getElementById('share-btn')?.addEventListener('click', copyShareLink);
  document.getElementById('download-btn')?.addEventListener('click', downloadVisibleAnimeList);
  document.getElementById('debug-anilist-btn')?.addEventListener('click', downloadAnilistDebug);

  // Min cluster size: stat-only recalculation, NO full graph re-render
  document.getElementById('apply-cluster-size')?.addEventListener('click', () => {
    const minCluster = parseInt(document.getElementById('min-cluster-size')?.value) || 1;
    if (!window._lastGraphNodes || !window._lastGraphLinks) return;
    const { count } = window.calculateAnimeClusters(window._lastGraphNodes, window._lastGraphLinks);
    if (minCluster > 1 && window.countClustersOfMinSize) {
      const f = window.countClustersOfMinSize(window._lastGraphNodes, window._lastGraphLinks, minCluster);
      document.getElementById('stat-clusters').textContent = `${f.toLocaleString()} (≥${minCluster})`;
    } else {
      document.getElementById('stat-clusters').textContent = count.toLocaleString();
    }
  });
  document.getElementById('mode-select')?.addEventListener('change', applyFiltersAndRender);
  document.querySelectorAll('.highlight-toggle input').forEach(i=>i.addEventListener('change', applyFiltersAndRender));

  // ── Sidebar collapse / open ────────────────────────────────────────────────
  const sidebar       = document.getElementById('sidebar');
  const collapseBtn   = document.getElementById('sidebar-collapse-btn');
  const openBtn       = document.getElementById('sidebar-open-btn');
  const overlay       = document.getElementById('sidebar-overlay');
  const isMobile      = () => window.innerWidth <= 640;

  function openSidebar() {
    sidebar.classList.remove('sidebar-collapsed');
    openBtn.classList.remove('visible');
    openBtn.style.display = 'none';
    if (isMobile()) overlay.classList.add('active');
    if (collapseBtn) collapseBtn.textContent = '\u25C4';
  }

  function closeSidebar() {
    sidebar.classList.add('sidebar-collapsed');
    openBtn.style.display = 'flex';
    openBtn.classList.add('visible');
    overlay.classList.remove('active');
    if (collapseBtn) collapseBtn.textContent = '\u25BA';
  }

  if (collapseBtn) collapseBtn.addEventListener('click', () => {
    if (sidebar.classList.contains('sidebar-collapsed')) openSidebar();
    else closeSidebar();
  });
  if (openBtn)    openBtn.addEventListener('click', openSidebar);
  if (overlay)    overlay.addEventListener('click', closeSidebar);

  // On mobile, start with sidebar closed
  if (isMobile()) closeSidebar();

  // ── Clickable cluster / chain stats ───────────────────────────────────────
  document.getElementById('stat-largest-cluster')?.addEventListener('click', () => {
    if (typeof highlightLargestCluster === 'function') highlightLargestCluster();
    document.getElementById('stat-largest-cluster')?.classList.toggle('active');
    document.getElementById('stat-longest-chain')?.classList.remove('active');
  });
  document.getElementById('stat-longest-chain')?.addEventListener('click', () => {
    if (typeof highlightLongestChain === 'function') highlightLongestChain();
    document.getElementById('stat-longest-chain')?.classList.toggle('active');
    document.getElementById('stat-largest-cluster')?.classList.remove('active');
  });

  initCollapsibleSections();

  loadDatabase().catch(err => {
    const msg = document.getElementById('loader-msg');
    msg.style.cssText = 'color:#c04030;max-width:420px;text-align:center;line-height:1.6;white-space:pre-wrap';
    msg.textContent = '\u2717 Failed to load database.\n\n' + err.message +
      '\n\nTry refreshing, or check your network.\nSome ad-blockers may block CDN requests.';
    console.error('DB load failed:', err);
  });
});
