/**
 * filters.js
 * ----------
 * Reads filter state from the sidebar and produces filtered subsets
 * of the pre-computed graph (nodes + edges).
 */

'use strict';

// ── COLOR PALETTES ────────────────────────────────────────────────────────────

const PALETTE = [
  '#e8a030','#c04060','#4080c0','#40a060','#9060c0','#c06040',
  '#40a0a0','#a0c040','#e06080','#6080e0','#e08040','#40c080',
  '#c040a0','#80e040','#4060c0','#e04040','#60c0e0','#c0a040',
  '#8040c0','#40c040','#e0c040','#c08060','#60a0c0','#a06080',
];

const NODE_TYPE_COLORS = {
  anime:     '#e8a030',
  studio:    '#4080c0',
  tag:       '#40a060',
  character: '#c04060',
  staff:     '#9060c0',
};

const ANIME_TYPE_COLORS = {
  TV:      '#e8a030',
  MOVIE:   '#c04060',
  OVA:     '#4080c0',
  ONA:     '#40a060',
  SPECIAL: '#9060c0',
  UNKNOWN: '#606060',
};

// Distinct year palette — uses full HSL sweep for clear differentiation
function yearColor(year) {
  if (!year) return '#555555';
  // Map 1960–2025 across hue 0→300 (magenta excluded)
  const t = Math.max(0, Math.min(1, (year - 1960) / 65));
  const hue = Math.round(t * 300);
  return `hsl(${hue},70%,55%)`;
}

// Shared color map (studio / tag / primary-tag modes)
let _colorMap = {};
let _colorIdx  = 0;

function resetColorMap() {
  _colorMap = {};
  _colorIdx  = 0;
}

function paletteColor(key) {
  if (!_colorMap[key]) {
    _colorMap[key] = PALETTE[_colorIdx++ % PALETTE.length];
  }
  return _colorMap[key];
}

/** Resolve the display color for a graph node given the current colorBy mode */
function getNodeColor(node, colorBy, nodeById) {
  const t = node.type;
  // Meta nodes always get their type color regardless of mode
  if (t !== 'anime') return NODE_TYPE_COLORS[t] || '#606060';

  switch (colorBy) {
    case 'node_type':
      return NODE_TYPE_COLORS.anime;
    case 'type':
      return ANIME_TYPE_COLORS[node.anime_type] || '#606060';
    case 'year':
      return yearColor(node.year);
    case 'studio': {
      const sid = (node.studio_ids || [])[0];
      if (!sid) return '#606060';
      const snode = nodeById.get(sid);
      return snode ? paletteColor(snode.name) : '#606060';
    }
    case 'tag': {
      const tid = (node.tag_ids || [])[0];
      if (!tid) return '#606060';
      const tnode = nodeById.get(tid);
      return tnode ? paletteColor(tnode.name) : '#606060';
    }
    default:
      return NODE_TYPE_COLORS.anime;
  }
}

// ── FILTER STATE READER ───────────────────────────────────────────────────────

function getFilters() {
  const types = new Set(
    [...document.querySelectorAll('#type-checkboxes input:checked')].map(i => i.value)
  );
  const visibleNodeTypes = new Set(
    [...document.querySelectorAll('#node-type-visibility input:checked')].map(i => i.value)
  );
  const yearFrom  = parseInt(document.getElementById('year-from').value) || 0;
  const yearTo    = parseInt(document.getElementById('year-to').value)   || 9999;
  const epMin     = parseInt(document.getElementById('ep-min').value)    || 0;
  const epMax     = parseInt(document.getElementById('ep-max').value)    || 999999;
  const lenMin    = parseFloat(document.getElementById('len-min').value) || 0;
  const lenMax    = parseFloat(document.getElementById('len-max').value) || 999999;

  const selTags      = [...document.getElementById('tag-select').selectedOptions].map(o => o.value);
  const selStudios   = [...document.getElementById('studio-select').selectedOptions].map(o => o.value);
  const selChars     = [...document.getElementById('character-select').selectedOptions].map(o => o.value);
  const selStaff     = [...document.getElementById('staff-select').selectedOptions].map(o => o.value);
  const search       = document.getElementById('search-input').value.trim().toLowerCase();
  const colorBy      = document.querySelector('input[name="colorby"]:checked')?.value || 'node_type';

  return {
    types, visibleNodeTypes,
    yearFrom, yearTo, epMin, epMax, lenMin, lenMax,
    selTags, selStudios, selChars, selStaff,
    search, colorBy,
  };
}

// ── FILTER + BUILD GRAPH DATA ─────────────────────────────────────────────────

/**
 * Given the full raw graph {nodes, edges} and current filters,
 * returns {nodes, links} ready for force-graph consumption.
 *
 * Strategy:
 *  1. Filter anime nodes to those that pass all anime-specific filters.
 *  2. Determine which meta node IDs are reachable from filtered anime.
 *  3. Include meta nodes whose type is visible.
 *  4. Filter edges to only those where both endpoints exist.
 */
function buildGraphData(rawGraph, filters, nodeById) {
  resetColorMap();

  const activeUserIds = getActiveUserIds ? getActiveUserIds() : null;

  // ── 1. Filter anime nodes ─────────────────────────────────────────────────
  const animeNodes = rawGraph.nodes.filter(n => n.type === 'anime');

  const filteredAnime = animeNodes.filter(a => {
    // User list filter
    if (activeUserIds !== null) {
      if (!activeUserIds.has(a.al_id)) return false;
    }
    // Anime type
    if (!filters.types.has(a.anime_type)) return false;
    // Year
    if (a.year && (a.year < filters.yearFrom || a.year > filters.yearTo)) return false;
    // Episodes
    const eps = a.episodes || 0;
    if (eps < filters.epMin || eps > filters.epMax) return false;
    // Total length
    const mins = totalMinutes(a);
    if (mins > 0 && (mins < filters.lenMin || mins > filters.lenMax)) return false;
    // Tag filter
    if (filters.selTags.length > 0) {
      const tagNames = (a.tag_ids || [])
        .map(id => nodeById.get(id)?.name)
        .filter(Boolean);
      if (!filters.selTags.some(t => tagNames.includes(t))) return false;
    }
    // Studio filter
    if (filters.selStudios.length > 0) {
      const studioNames = (a.studio_ids || [])
        .map(id => nodeById.get(id)?.name)
        .filter(Boolean);
      if (!filters.selStudios.some(s => studioNames.includes(s))) return false;
    }
    // Character / staff: skip if no character data in DB
    // (placeholders for when FETCH_ANILIST=True was used)
    // Search
    if (filters.search) {
      const title   = (a.title    || '').toLowerCase();
      const titleEn = (a.title_en || '').toLowerCase();
      if (!title.includes(filters.search) && !titleEn.includes(filters.search)) return false;
    }
    return true;
  });

  const filteredAnimeIds = new Set(filteredAnime.map(n => n.node_id));

  // ── 2. Find reachable meta node IDs ───────────────────────────────────────
  // (only meta nodes connected to at least one filtered anime are included)
  const reachableMetaIds = new Set();
  rawGraph.edges.forEach(e => {
    if (filteredAnimeIds.has(e.s) && !filteredAnimeIds.has(e.t)) reachableMetaIds.add(e.t);
    if (filteredAnimeIds.has(e.t) && !filteredAnimeIds.has(e.s)) reachableMetaIds.add(e.s);
  });

  // ── 3. Collect visible meta nodes ─────────────────────────────────────────
  const metaNodes = rawGraph.nodes.filter(n =>
    n.type !== 'anime'
    && reachableMetaIds.has(n.node_id)
    && filters.visibleNodeTypes.has(n.type)
  );

  // Apply character/staff name filter
  const selCharsSet = new Set(filters.selChars);
  const selStaffSet = new Set(filters.selStaff);
  const visibleMetaIds = new Set();
  metaNodes.forEach(n => {
    if (n.type === 'character' && selCharsSet.size > 0 && !selCharsSet.has(n.name)) return;
    if (n.type === 'staff'     && selStaffSet.size > 0 && !selStaffSet.has(n.name)) return;
    visibleMetaIds.add(n.node_id);
  });

  const visibleMeta = metaNodes.filter(n => visibleMetaIds.has(n.node_id));

  // ── 4. All visible node IDs ───────────────────────────────────────────────
  const allVisibleIds = new Set([...filteredAnimeIds, ...visibleMetaIds]);

  // ── 5. Filter edges ───────────────────────────────────────────────────────
  // Only include edges that fit the visible node types filter for meta side
  const visibleEdgeKinds = new Set();
  if (filters.visibleNodeTypes.has('studio'))    visibleEdgeKinds.add('studio');
  if (filters.visibleNodeTypes.has('tag'))       visibleEdgeKinds.add('tag');
  if (filters.visibleNodeTypes.has('character')) visibleEdgeKinds.add('character');
  if (filters.visibleNodeTypes.has('staff'))     visibleEdgeKinds.add('staff');
  // Always include anime↔anime related edges
  visibleEdgeKinds.add('related');

  const filteredEdges = rawGraph.edges.filter(e =>
    allVisibleIds.has(e.s) && allVisibleIds.has(e.t) && visibleEdgeKinds.has(e.k)
  );

  // ── 6. Assign colors ──────────────────────────────────────────────────────
  const colorBy = filters.colorBy;
  const allNodes = [...filteredAnime, ...visibleMeta];

  allNodes.forEach(n => {
    n._color = getNodeColor(n, colorBy, nodeById);
  });

  // ── 7. Build force-graph node/link arrays ─────────────────────────────────
  // force-graph uses numeric ids; we already have node_id as unique integers
  const nodes = allNodes.map(n => ({
    id:    n.node_id,
    label: n.title || n.title_en || n.name || '?',
    color: n._color,
    val:   nodeSize(n),
    data:  n,
  }));

  const links = filteredEdges.map(e => ({ source: e.s, target: e.t, kind: e.k }));

  return { nodes, links, filteredAnime, visibleMeta };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function totalMinutes(anime) {
  if (!anime.duration) return 0;
  const eps = anime.episodes || 1;
  return (eps * anime.duration) / 60;
}

function nodeSize(n) {
  if (n.type === 'anime')     return Math.max(0.5, Math.log((n.episodes || 1) + 1) * 0.8);
  if (n.type === 'studio')    return 1.5;
  if (n.type === 'tag')       return 1.2;
  if (n.type === 'character') return 0.8;
  if (n.type === 'staff')     return 0.9;
  return 1;
}

// ── LEGEND BUILDER ────────────────────────────────────────────────────────────

function buildLegend(filteredAnime, colorBy) {
  const container = document.getElementById('legend-items');
  container.innerHTML = '';

  function addItem(color, label) {
    const div = document.createElement('div');
    div.className = 'legend-item';
    div.innerHTML = `<div class="legend-dot" style="background:${color}"></div>
      <span style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${label}</span>`;
    container.appendChild(div);
  }

  if (colorBy === 'node_type') {
    Object.entries(NODE_TYPE_COLORS).forEach(([type, col]) => {
      addItem(col, type.charAt(0).toUpperCase() + type.slice(1));
    });
    return;
  }

  if (colorBy === 'type') {
    const counts = {};
    filteredAnime.forEach(a => { counts[a.anime_type] = (counts[a.anime_type] || 0) + 1; });
    Object.entries(ANIME_TYPE_COLORS).forEach(([type, col]) => {
      if (counts[type]) addItem(col, `${type} (${counts[type].toLocaleString()})`);
    });
    return;
  }

  if (colorBy === 'year') {
    [[1960,'≤1960'],[1975,'1975'],[1990,'1990'],[2005,'2005'],[2015,'2015'],[2023,'2023+']].forEach(([y, label]) => {
      addItem(yearColor(y), label);
    });
    return;
  }

  // studio or tag — top 10 by count
  const counts = {};
  filteredAnime.forEach(a => {
    const key = colorBy === 'studio'
      ? Object.keys(_colorMap).find(k => (a.studio_ids || []).length > 0) // resolved below
      : null;
    // re-derive the primary key from colorMap keys we've already assigned
  });
  // Show whatever was assigned to _colorMap, sorted by frequency
  const sorted = Object.entries(_colorMap).slice(0, 12);
  sorted.forEach(([key, col]) => addItem(col, key));
}

// ── CLUSTER COUNTER (anime-only) ──────────────────────────────────────────────

function calculateAnimeClusters(nodes, links) {
  // Only count clusters among anime nodes — ignore meta nodes
  const animeNodeIds = new Set(
    nodes.filter(n => n.data?.type === 'anime').map(n => n.id)
  );
  if (animeNodeIds.size === 0) return 0;

  const adj = new Map();
  animeNodeIds.forEach(id => adj.set(id, []));

  links.forEach(l => {
    const src = typeof l.source === 'object' ? l.source.id : l.source;
    const tgt = typeof l.target === 'object' ? l.target.id : l.target;
    if (animeNodeIds.has(src) && animeNodeIds.has(tgt)) {
      adj.get(src).push(tgt);
      adj.get(tgt).push(src);
    }
  });

  const visited = new Set();
  let count = 0;
  animeNodeIds.forEach(id => {
    if (!visited.has(id)) {
      count++;
      const stack = [id];
      visited.add(id);
      while (stack.length) {
        const cur = stack.pop();
        (adj.get(cur) || []).forEach(nb => {
          if (!visited.has(nb)) { visited.add(nb); stack.push(nb); }
        });
      }
    }
  });
  return count;
}
