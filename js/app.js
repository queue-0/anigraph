/**
 * app.js
 * ------
 * Main application entry point.
 * Loads the pre-computed graph database, populates filter UI,
 * wires up all events, and manages:
 *  - Collapsible sidebar sections
 *  - URL hash state (shareable filter links)
 *  - Share button
 *  - Clear All Filters
 *  - Per-section Apply Filters buttons
 *  - Mode selector
 *  - Download list button
 *  - Country checkbox population
 */

'use strict';

// ── GLOBALS ───────────────────────────────────────────────────────────────────
let rawGraph = null;
window._nodeById  = new Map();
window.rawGraph   = null;  // also exposed for anilist.js computeRelatedAnime

const DATA_URL = './data/anime-graph.json';

// ── DEFAULTS ──────────────────────────────────────────────────────────────────
const DEFAULTS = {
  types:          ['TV','MOVIE','OVA','ONA','SPECIAL','UNKNOWN'],
  releaseStatuses:['FINISHED','RELEASING','NOT_YET_RELEASED','CANCELLED','HIATUS','UNKNOWN'],
  nodeTypes:      ['anime','studio','genre'],
  yearFrom:       1917, yearTo:    2030,
  epMin:          0,    epMax:     9999,
  lenMin:         0,    lenMax:    999999,
  scoreMin:       0,    scoreMax:  10,
  colorBy:        'node_type',
  nodeSizeBy:     'default',
  search:         '',
  selTags:        [], selGenres: [], selStudios: [], selChars: [], selStaff: [],
  username:       '',
  listStatuses:   ['COMPLETED','PLANNING','CURRENT','PAUSED','DROPPED','REPEATING','RELATED'],
  minClusterSize: 1,
  mode:           'all',
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

  setProgress(65, 'Building node index (' + rawGraph.nodes.length.toLocaleString() + ' nodes)…');
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
  const studios = [], tags = [], genres = [], characters = [], staff = [];
  const countriesFound = new Set();

  rawGraph.nodes.forEach(n => {
    switch (n.type) {
      case 'studio':    studios.push(n.name);    break;
      case 'genre':     genres.push(n.name);     break;
      case 'tag':       tags.push(n.name);       break;
      case 'character': characters.push(n.name); break;
      case 'staff':     staff.push(n.name);      break;
      case 'anime':
        if (n.country) countriesFound.add(n.country);
        break;
    }
  });

  studios.sort(); tags.sort(); genres.sort(); characters.sort(); staff.sort();
  fillSelect('studio-select',    studios);
  fillSelect('tag-select',       tags);
  fillSelect('genre-select',     genres);
  fillSelect('character-select', characters);
  fillSelect('staff-select',     staff);

  wireSearch('studio-search',    'studio-select');
  wireSearch('tag-search',       'tag-select');
  wireSearch('genre-search',     'genre-select');
  wireSearch('character-search', 'character-select');
  wireSearch('staff-search',     'staff-select');

  wireClear('studio-clear',    'studio-select');
  wireClear('tag-clear',       'tag-select');
  wireClear('genre-clear',     'genre-select');
  wireClear('character-clear', 'character-select');
  wireClear('staff-clear',     'staff-select');

  // Populate country checkboxes dynamically
  populateCountryCheckboxes(countriesFound);
}

function populateCountryCheckboxes(countriesFound) {
  const container = document.getElementById('country-checkboxes');
  if (!container) return;
  container.innerHTML = '';

  const COUNTRY_LABELS = window.COUNTRY_LABELS || {};
  // Sort: known countries first, then unknown
  const known   = [...countriesFound].filter(c => c !== '??').sort();
  const unknown = countriesFound.has('??') ? ['??'] : [];

  [...known, ...unknown].forEach(code => {
    const label = COUNTRY_LABELS[code] || code;
    const el = document.createElement('label');
    el.className = 'check-item';
    el.innerHTML = `<input type="checkbox" value="${code}" checked> ${label}`;
    container.appendChild(el);
  });
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
  renderGraph(result);
  buildLegend(result.filteredAnime, filters.colorBy, filters.visibleNodeTypes, result.visibleMeta);

  const activeIds = getActiveUserIds ? getActiveUserIds() : null;
  const modeLabel = filters.mode === 'user' && activeIds !== null
    ? 'My List (' + result.filteredAnime.length.toLocaleString() + ')'
    : 'All Anime';
  document.querySelector('#mode-pill span').textContent = modeLabel;

  clearTimeout(window._urlTimer);
  window._urlTimer = setTimeout(saveToUrl, 300);
}

// ── DOWNLOAD BUTTON ───────────────────────────────────────────────────────────
function downloadVisibleAnimeList() {
  if (!rawGraph) return;
  const filters = getFilters();
  const result  = buildGraphData(rawGraph, filters, window._nodeById);

  const allAnime = [...result.filteredAnime, ...(result.highlightedAnime || [])];
  if (allAnime.length === 0) {
    alert('No anime currently visible.');
    return;
  }

  const lines = allAnime.map(a => {
    const title = a.title_en || a.title || '?';
    const year  = a.year ? ` (${a.year})` : '';
    return `${title}${year}`;
  });
  lines.sort();

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'anigraph-list.txt';
  a.click();
  URL.revokeObjectURL(url);
}

// ── URL STATE ─────────────────────────────────────────────────────────────────
function saveToUrl() {
  try {
    const s = {};

    const checkedTypes = [...document.querySelectorAll('#type-checkboxes input:checked')].map(i => i.value);
    if (checkedTypes.length !== DEFAULTS.types.length) s.t = checkedTypes.join(',');

    const visTypes = [...document.querySelectorAll('#node-type-visibility input:checked')].map(i => i.value);
    if (JSON.stringify([...visTypes].sort()) !== JSON.stringify([...DEFAULTS.nodeTypes].sort()))
      s.nt = visTypes.join(',');

    const yf = parseInt(document.getElementById('year-from').value);
    const yt = parseInt(document.getElementById('year-to').value);
    if (yf !== DEFAULTS.yearFrom) s.yf = yf;
    if (yt !== DEFAULTS.yearTo)   s.yt = yt;

    const ef = parseInt(document.getElementById('ep-min').value);
    const et = parseInt(document.getElementById('ep-max').value);
    if (ef !== DEFAULTS.epMin) s.ef = ef;
    if (et !== DEFAULTS.epMax) s.et = et;

    const lf = parseFloat(document.getElementById('len-min').value);
    const lt = parseFloat(document.getElementById('len-max').value);
    if (lf !== DEFAULTS.lenMin) s.lf = lf;
    if (lt !== DEFAULTS.lenMax) s.lt = lt;

    const sf = parseFloat(document.getElementById('score-min').value);
    const st = parseFloat(document.getElementById('score-max').value);
    if (sf !== DEFAULTS.scoreMin) s.smn = sf;
    if (st !== DEFAULTS.scoreMax) s.smx = st;

    const cb = document.querySelector('input[name="colorby"]:checked')?.value;
    if (cb && cb !== DEFAULTS.colorBy) s.cb = cb;

    const nsb = document.querySelector('input[name="nodeSizeBy"]:checked')?.value;
    if (nsb && nsb !== DEFAULTS.nodeSizeBy) s.nsb = nsb;

    const srch = document.getElementById('search-input').value.trim();
    if (srch) s.q = srch;

    const tags    = [...document.getElementById('tag-select').selectedOptions].map(o => o.value);
    const genres  = [...document.getElementById('genre-select').selectedOptions].map(o => o.value);
    const studios = [...document.getElementById('studio-select').selectedOptions].map(o => o.value);
    const chars   = [...document.getElementById('character-select').selectedOptions].map(o => o.value);
    const stf     = [...document.getElementById('staff-select').selectedOptions].map(o => o.value);
    if (tags.length)    s.tg = tags.join('|');
    if (genres.length)  s.gn = genres.join('|');
    if (studios.length) s.st = studios.join('|');
    if (chars.length)   s.ch = chars.join('|');
    if (stf.length)     s.sf = stf.join('|');

    const mc = parseInt(document.getElementById('min-cluster-size')?.value) || 1;
    if (mc !== DEFAULTS.minClusterSize) s.mc = mc;

    const mode = document.getElementById('mode-select')?.value || 'all';
    if (mode !== DEFAULTS.mode) s.md = mode;

    const username = document.getElementById('username-input').value.trim();
    if (username) {
      s.u = username;
      const statuses = [...document.querySelectorAll('#list-status-checkboxes input:checked')].map(i => i.value);
      if (statuses.length !== DEFAULTS.listStatuses.length) s.ls = statuses.join(',');
    }

    history.replaceState(null, '', Object.keys(s).length ? '#' + new URLSearchParams(s).toString() : '#');
  } catch (_) {}
}

async function restoreFromUrl() {
  const hash = window.location.hash.slice(1);
  if (!hash) return;
  try {
    const p = new URLSearchParams(hash);

    if (p.has('t')) {
      const vals = new Set(p.get('t').split(','));
      document.querySelectorAll('#type-checkboxes input').forEach(i => { i.checked = vals.has(i.value); });
    }
    if (p.has('nt')) {
      const vals = new Set(p.get('nt').split(','));
      document.querySelectorAll('#node-type-visibility input').forEach(i => { i.checked = vals.has(i.value); });
    }
    if (p.has('yf'))  document.getElementById('year-from').value  = p.get('yf');
    if (p.has('yt'))  document.getElementById('year-to').value    = p.get('yt');
    if (p.has('ef'))  document.getElementById('ep-min').value     = p.get('ef');
    if (p.has('et'))  document.getElementById('ep-max').value     = p.get('et');
    if (p.has('lf'))  document.getElementById('len-min').value    = p.get('lf');
    if (p.has('lt'))  document.getElementById('len-max').value    = p.get('lt');
    if (p.has('smn')) document.getElementById('score-min').value  = p.get('smn');
    if (p.has('smx')) document.getElementById('score-max').value  = p.get('smx');
    if (p.has('mc'))  document.getElementById('min-cluster-size').value = p.get('mc');

    if (p.has('cb')) {
      const radio = document.querySelector('input[name="colorby"][value="' + p.get('cb') + '"]');
      if (radio) radio.checked = true;
    }
    if (p.has('nsb')) {
      const radio = document.querySelector('input[name="nodeSizeBy"][value="' + p.get('nsb') + '"]');
      if (radio) radio.checked = true;
    }
    if (p.has('q')) document.getElementById('search-input').value = p.get('q');
    if (p.has('md')) {
      const sel = document.getElementById('mode-select');
      if (sel) sel.value = p.get('md');
    }

    function restoreSelect(id, raw) {
      if (!raw) return;
      const vals = new Set(raw.split('|'));
      const sel  = document.getElementById(id);
      if (!sel) return;
      [...sel.options].forEach(o => { o.selected = vals.has(o.value); });
    }
    restoreSelect('tag-select',       p.get('tg'));
    restoreSelect('genre-select',     p.get('gn'));
    restoreSelect('studio-select',    p.get('st'));
    restoreSelect('character-select', p.get('ch'));
    restoreSelect('staff-select',     p.get('sf'));

    if (p.has('u')) {
      document.getElementById('username-input').value = p.get('u');
      if (p.has('ls')) {
        const vals = new Set(p.get('ls').split(','));
        document.querySelectorAll('#list-status-checkboxes input').forEach(i => { i.checked = vals.has(i.value); });
      }
      await fetchUserList();
      if (p.has('cb')) {
        const radio = document.querySelector('input[name="colorby"][value="' + p.get('cb') + '"]');
        if (radio) radio.checked = true;
      }
    }
  } catch (e) { console.warn('URL restore failed:', e); }
}

// ── SHARE ─────────────────────────────────────────────────────────────────────
function copyShareLink() {
  saveToUrl();
  const url = window.location.href;
  const doFallback = () => {
    const ta = document.createElement('textarea');
    ta.value = url; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    showShareToast('Link copied!');
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => showShareToast('Link copied!')).catch(doFallback);
  } else { doFallback(); }
}

function showShareToast(msg) {
  let t = document.getElementById('share-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'share-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('visible'), 2200);
}

// ── CLEAR ALL FILTERS ─────────────────────────────────────────────────────────
function clearAllFilters() {
  document.querySelectorAll('#type-checkboxes input').forEach(i => i.checked = true);
  document.querySelectorAll('#release-status-checkboxes input').forEach(i => i.checked = true);
  document.querySelectorAll('#country-checkboxes input').forEach(i => i.checked = true);

  const defNT = new Set(DEFAULTS.nodeTypes);
  document.querySelectorAll('#node-type-visibility input').forEach(i => { i.checked = defNT.has(i.value); });

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

  ['tag-select','genre-select','studio-select','character-select','staff-select'].forEach(id => {
    const sel = document.getElementById(id);
    if (sel) [...sel.options].forEach(o => o.selected = false);
  });

  // Reset all highlight toggles
  document.querySelectorAll('.highlight-toggle input').forEach(i => i.checked = false);

  // Reset mode
  const modeSelect = document.getElementById('mode-select');
  if (modeSelect) modeSelect.value = 'all';

  history.replaceState(null, '', window.location.pathname + window.location.search);
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
  document.querySelectorAll('input[name="colorby"]').forEach(r => {
    r.addEventListener('change', applyFiltersAndRender);
  });
  document.querySelectorAll('input[name="nodeSizeBy"]').forEach(r => {
    r.addEventListener('change', applyFiltersAndRender);
  });
  document.getElementById('node-type-visibility').addEventListener('change', applyFiltersAndRender);
  document.getElementById('search-input').addEventListener('input', () => {
    clearTimeout(window._searchTimer);
    window._searchTimer = setTimeout(applyFiltersAndRender, 400);
  });
  document.querySelectorAll('.section-apply-btn').forEach(btn => {
    btn.addEventListener('click', applyFiltersAndRender);
  });
  document.getElementById('clear-all-btn')?.addEventListener('click', clearAllFilters);
  document.getElementById('share-btn')?.addEventListener('click', copyShareLink);
  document.getElementById('download-btn')?.addEventListener('click', downloadVisibleAnimeList);
  document.getElementById('apply-cluster-size')?.addEventListener('click', applyFiltersAndRender);
  document.getElementById('mode-select')?.addEventListener('change', applyFiltersAndRender);

  // Highlight toggles — re-render on change
  document.querySelectorAll('.highlight-toggle input').forEach(i => {
    i.addEventListener('change', applyFiltersAndRender);
  });

  initCollapsibleSections();

  loadDatabase().catch(err => {
    const msg = document.getElementById('loader-msg');
    msg.style.cssText = 'color:#c04030;max-width:420px;text-align:center;line-height:1.6;white-space:pre-wrap';
    msg.textContent = '✗ Failed to load database.\n\n' + err.message +
      '\n\nTry refreshing, or check your network.\nSome ad-blockers may block CDN requests.';
    console.error('DB load failed:', err);
  });
});
