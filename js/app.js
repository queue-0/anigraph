/**
 * app.js
 * ------
 * Main application entry point.
 * Loads the pre-computed graph database, populates filter UI,
 * wires up all events, and manages collapsible sidebar sections.
 */

'use strict';

// ── GLOBALS ───────────────────────────────────────────────────────────────────

let rawGraph = null;
window._nodeById = new Map();

const DATA_URL = './data/anime-graph.json';

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
  setProgress(5, 'Fetching anime graph database…');

  let res;
  try {
    res = await fetchWithTimeout(DATA_URL, 60000);
    if (!res.ok) throw new Error(`HTTP ${res.status} — is data/anime-graph.json committed?`);
  } catch (e) {
    throw new Error(e.message);
  }

  setProgress(15, 'Downloading…');

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text     += decoder.decode(value, { stream: true });
    received += value?.length || 0;
    const pct = Math.min(50, 15 + (received / 12_000_000) * 35);
    setProgress(pct, `Downloading… ${(received / 1_048_576).toFixed(1)} MB`);
    await new Promise(r => setTimeout(r, 0));
  }

  setProgress(55, 'Parsing JSON…');
  await new Promise(r => setTimeout(r, 0));
  rawGraph = JSON.parse(text);

  setProgress(65, `Building node index (${rawGraph.nodes.length.toLocaleString()} nodes)…`);
  await new Promise(r => setTimeout(r, 0));

  rawGraph.nodes.forEach(n => window._nodeById.set(n.node_id, n));

  document.getElementById('stat-total').textContent =
    (rawGraph.meta?.total_anime ?? rawGraph.nodes.filter(n => n.type === 'anime').length).toLocaleString();

  setProgress(75, 'Building filter lists…');
  populateFilterLists();

  setProgress(88, 'Initialising graph engine…');
  initGraph();

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
  const studios    = [];
  const tags       = [];
  const characters = [];
  const staff      = [];

  rawGraph.nodes.forEach(n => {
    switch (n.type) {
      case 'studio':    studios.push(n.name);    break;
      case 'tag':       tags.push(n.name);       break;
      case 'character': characters.push(n.name); break;
      case 'staff':     staff.push(n.name);      break;
    }
  });

  studios.sort();
  tags.sort();
  characters.sort();
  staff.sort();

  fillSelect('studio-select',    studios);
  fillSelect('tag-select',       tags);
  fillSelect('character-select', characters);
  fillSelect('staff-select',     staff);

  wireSearch('studio-search',    'studio-select');
  wireSearch('tag-search',       'tag-select');
  wireSearch('character-search', 'character-select');
  wireSearch('staff-search',     'staff-select');

  wireClear('studio-clear',    'studio-select');
  wireClear('tag-clear',       'tag-select');
  wireClear('character-clear', 'character-select');
  wireClear('staff-clear',     'staff-select');
}

function fillSelect(selectId, items) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  items.forEach(name => {
    const opt       = document.createElement('option');
    opt.value       = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
}

function wireSearch(inputId, selectId) {
  const input = document.getElementById(inputId);
  const sel   = document.getElementById(selectId);
  if (!input || !sel) return;
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    [...sel.options].forEach(o => {
      o.style.display = o.value.toLowerCase().includes(q) ? '' : 'none';
    });
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
  buildLegend(result.filteredAnime, filters.colorBy, filters.visibleNodeTypes);

  const activeIds = getActiveUserIds ? getActiveUserIds() : null;
  document.querySelector('#mode-pill span').textContent =
    activeIds !== null
      ? `My List (${result.filteredAnime.length.toLocaleString()})`
      : `All Anime`;
}

// ── COLLAPSIBLE SECTIONS ──────────────────────────────────────────────────────

function initCollapsibleSections() {
  document.querySelectorAll('.section-header').forEach(header => {
    const sectionKey = header.dataset.section;
    const bodyId     = `section-body-${sectionKey}`;
    const body       = document.getElementById(bodyId);
    const icon       = header.querySelector('.collapse-icon');
    if (!body) return;

    header.addEventListener('click', () => {
      const isCollapsed = body.classList.toggle('collapsed');
      if (icon) icon.textContent = isCollapsed ? '▸' : '▾';
    });
  });
}

// ── EVENT WIRING ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Apply button
  document.getElementById('apply-btn')
    .addEventListener('click', applyFiltersAndRender);

  // Color-by radio — immediate re-render
  document.querySelectorAll('input[name="colorby"]').forEach(r => {
    r.addEventListener('change', applyFiltersAndRender);
  });

  // Node type visibility — immediate re-render
  document.getElementById('node-type-visibility')
    .addEventListener('change', applyFiltersAndRender);

  // Search input — debounced
  document.getElementById('search-input').addEventListener('input', () => {
    clearTimeout(window._searchTimer);
    window._searchTimer = setTimeout(applyFiltersAndRender, 400);
  });

  // Collapsible sections
  initCollapsibleSections();

  // Start loading
  loadDatabase().catch(err => {
    const msg = document.getElementById('loader-msg');
    msg.style.color     = '#c04030';
    msg.style.maxWidth  = '420px';
    msg.style.textAlign = 'center';
    msg.style.lineHeight = '1.6';
    msg.style.whiteSpace = 'pre-wrap';
    msg.textContent =
      '✗ Failed to load database.\n\n' + err.message +
      '\n\nTry refreshing, or check your network.\nSome ad-blockers may block CDN requests.';
    console.error('DB load failed:', err);
  });
});
