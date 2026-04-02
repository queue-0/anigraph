/**
 * filters.js
 * ----------
 * Reads filter state from the sidebar and produces filtered subsets
 * of the pre-computed graph (nodes + edges).
 *
 * Key behaviours:
 *  - Meta nodes (studio/tag/character/staff) are only shown if connected
 *    to a filtered anime AND their type is visible.
 *  - When a filter for a specific meta type is active (e.g. Studio = MAPPA),
 *    only those matching meta nodes appear — other meta nodes on unrelated
 *    anime are hidden even if "Show Studios" is checked.
 *  - Tag edges are sampled to limit lag (configurable TAG_EDGE_SAMPLE_RATE).
 *  - Colors: meta node types always use fixed, distinct colors regardless
 *    of the "Color Nodes By" mode. Anime nodes use the selected mode.
 */

'use strict';

// ── TAG EDGE PERFORMANCE CONTROL ──────────────────────────────────────────────
// Tags create massive edge counts. We cap the number of anime connected to
// each tag node in the rendered graph to avoid thousands of overlapping lines.
// Set to Infinity to disable. Recommended: 30–80 for smooth rendering.
const TAG_EDGE_MAX_PER_TAG = 50;

// ── FIXED META NODE COLORS (always the same, never overlap anime colors) ─────
const META_NODE_COLORS = {
  studio:    '#5eb8ff',   // sky blue
  tag:       '#5dde9a',   // mint green
  character: '#ff7eb3',   // pink
  staff:     '#c09cff',   // lavender
};

// ── ANIME-SPECIFIC COLOR PALETTES ─────────────────────────────────────────────
// Deliberately avoid the meta node colors above

const ANIME_TYPE_COLORS = {
  TV:      '#f0a030',   // amber
  MOVIE:   '#e05050',   // coral red
  OVA:     '#e080d0',   // orchid
  ONA:     '#a0d060',   // lime
  SPECIAL: '#d06030',   // burnt orange
  UNKNOWN: '#606060',
};

// Year bands — each covers a decade-ish range for the legend
const YEAR_BANDS = [
  { max: 1969, label: '≤1969', hue: 0   },
  { max: 1979, label: '1970s', hue: 25  },
  { max: 1989, label: '1980s', hue: 50  },
  { max: 1999, label: '1990s', hue: 100 },
  { max: 2009, label: '2000s', hue: 160 },
  { max: 2014, label: '2010–14', hue: 200 },
  { max: 2019, label: '2015–19', hue: 240 },
  { max: 2024, label: '2020–24', hue: 270 },
  { max: 9999, label: '2025+',   hue: 300 },
];

function yearColor(year) {
  if (!year) return '#555555';
  const band = YEAR_BANDS.find(b => year <= b.max) || YEAR_BANDS[YEAR_BANDS.length - 1];
  return `hsl(${band.hue},70%,55%)`;
}

function yearBandLabel(year) {
  if (!year) return 'Unknown';
  return (YEAR_BANDS.find(b => year <= b.max) || YEAR_BANDS[YEAR_BANDS.length - 1]).label;
}

// Completion status colors — imported from anilist.js (window.COMPLETION_STATUS_COLORS)

// ── FILTER STATE READER ───────────────────────────────────────────────────────

function getFilters() {
  const types = new Set(
    [...document.querySelectorAll('#type-checkboxes input:checked')].map(i => i.value)
  );
  const visibleNodeTypes = new Set(
    [...document.querySelectorAll('#node-type-visibility input:checked')].map(i => i.value)
  );
  const yearFrom = parseInt(document.getElementById('year-from').value) || 0;
  const yearTo   = parseInt(document.getElementById('year-to').value)   || 9999;
  const epMin    = parseInt(document.getElementById('ep-min').value)    || 0;
  const epMax    = parseInt(document.getElementById('ep-max').value)    || 999999;
  const lenMin   = parseFloat(document.getElementById('len-min').value) || 0;
  const lenMax   = parseFloat(document.getElementById('len-max').value) || 999999;

  const selTags    = [...document.getElementById('tag-select').selectedOptions].map(o => o.value);
  const selStudios = [...document.getElementById('studio-select').selectedOptions].map(o => o.value);
  const selChars   = [...document.getElementById('character-select').selectedOptions].map(o => o.value);
  const selStaff   = [...document.getElementById('staff-select').selectedOptions].map(o => o.value);
  const search     = document.getElementById('search-input').value.trim().toLowerCase();
  const colorBy    = document.querySelector('input[name="colorby"]:checked')?.value || 'node_type';

  return {
    types, visibleNodeTypes,
    yearFrom, yearTo, epMin, epMax, lenMin, lenMax,
    selTags, selStudios, selChars, selStaff,
    search, colorBy,
  };
}

// ── COLOR RESOLVER ────────────────────────────────────────────────────────────

function getNodeColor(node, colorBy, nodeById) {
  // Meta nodes always use their fixed color
  if (node.type !== 'anime') {
    return META_NODE_COLORS[node.type] || '#808080';
  }

  switch (colorBy) {
    case 'node_type':
      // Anime color must differ from all meta colors — use a warm gold
      return '#e8a030';

    case 'type':
      return ANIME_TYPE_COLORS[node.anime_type] || '#606060';

    case 'year':
      return yearColor(node.year);

    case 'completion': {
      const status = getUserStatusForAnime ? getUserStatusForAnime(node.al_id) : null;
      if (!status) return '#555555';
      return (window.COMPLETION_STATUS_COLORS || {})[status] || '#808080';
    }

    default:
      return '#e8a030';
  }
}

// ── FILTER + BUILD GRAPH DATA ─────────────────────────────────────────────────

function buildGraphData(rawGraph, filters, nodeById) {
  const activeUserIds = getActiveUserIds ? getActiveUserIds() : null;

  // Build a fast lookup: al_id → node for anime
  // (nodeById is node_id→node; we need al_id→node for user list lookups)
  // Already in nodeById as node.al_id field.

  // ── 1. Filter anime nodes ─────────────────────────────────────────────────
  const animeNodes    = rawGraph.nodes.filter(n => n.type === 'anime');
  const filteredAnime = animeNodes.filter(a => {
    if (activeUserIds !== null && !activeUserIds.has(a.al_id)) return false;
    if (!filters.types.has(a.anime_type)) return false;
    if (a.year && (a.year < filters.yearFrom || a.year > filters.yearTo)) return false;
    const eps  = a.episodes || 0;
    if (eps < filters.epMin || eps > filters.epMax) return false;
    const mins = totalMinutes(a);
    if (mins > 0 && (mins < filters.lenMin || mins > filters.lenMax)) return false;

    // Tag filter — anime must have ALL selected tags (OR logic: any)
    if (filters.selTags.length > 0) {
      const tagNames = (a.tag_ids || []).map(id => nodeById.get(id)?.name).filter(Boolean);
      if (!filters.selTags.some(t => tagNames.includes(t))) return false;
    }
    // Studio filter
    if (filters.selStudios.length > 0) {
      const studioNames = (a.studio_ids || []).map(id => nodeById.get(id)?.name).filter(Boolean);
      if (!filters.selStudios.some(s => studioNames.includes(s))) return false;
    }
    // Character / staff filters (only relevant when FETCH_ANILIST=True)
    // Search
    if (filters.search) {
      const title   = (a.title    || '').toLowerCase();
      const titleEn = (a.title_en || '').toLowerCase();
      if (!title.includes(filters.search) && !titleEn.includes(filters.search)) return false;
    }
    return true;
  });

  const filteredAnimeIds = new Set(filteredAnime.map(n => n.node_id));

  // ── 2. Determine which meta node IDs are "reachable" from filtered anime ──
  // Build edge adjacency for quick lookup
  const animeToMeta = new Map(); // anime node_id → [{metaId, kind}]
  rawGraph.edges.forEach(e => {
    const aIsAnime = filteredAnimeIds.has(e.s) && !filteredAnimeIds.has(e.t);
    const bIsAnime = filteredAnimeIds.has(e.t) && !filteredAnimeIds.has(e.s);
    if (aIsAnime) {
      if (!animeToMeta.has(e.s)) animeToMeta.set(e.s, []);
      animeToMeta.get(e.s).push({ metaId: e.t, kind: e.k });
    } else if (bIsAnime) {
      if (!animeToMeta.has(e.t)) animeToMeta.set(e.t, []);
      animeToMeta.get(e.t).push({ metaId: e.s, kind: e.k });
    }
  });

  // ── 3. Determine "explicitly filtered" meta IDs per type ─────────────────
  // When a user picks specific studios/tags/chars/staff, only those meta nodes
  // should appear — even if their anime connects to other meta nodes too.
  const explicitStudios   = new Set(filters.selStudios);
  const explicitTags      = new Set(filters.selTags);
  const explicitChars     = new Set(filters.selChars);
  const explicitStaff     = new Set(filters.selStaff);
  const hasExplicitFilter = (
    explicitStudios.size > 0 || explicitTags.size > 0 ||
    explicitChars.size  > 0 || explicitStaff.size > 0
  );

  // ── 4. Build visible meta node set ───────────────────────────────────────
  // Track how many times each tag-meta node has been linked (for rate limiting)
  const tagEdgeCount = new Map();
  const visibleMetaIds = new Set();

  for (const [, metaList] of animeToMeta) {
    for (const { metaId, kind } of metaList) {
      const metaNode = nodeById.get(metaId);
      if (!metaNode || !filters.visibleNodeTypes.has(metaNode.type)) continue;

      // If there's an explicit filter for this type, only show matching nodes
      if (metaNode.type === 'studio' && explicitStudios.size > 0 && !explicitStudios.has(metaNode.name)) continue;
      if (metaNode.type === 'tag'    && explicitTags.size    > 0 && !explicitTags.has(metaNode.name))    continue;
      if (metaNode.type === 'character' && explicitChars.size > 0 && !explicitChars.has(metaNode.name)) continue;
      if (metaNode.type === 'staff'  && explicitStaff.size   > 0 && !explicitStaff.has(metaNode.name))  continue;

      visibleMetaIds.add(metaId);
    }
  }

  const visibleMeta = rawGraph.nodes.filter(n => visibleMetaIds.has(n.node_id));
  const allVisibleIds = new Set([...filteredAnimeIds, ...visibleMetaIds]);

  // ── 5. Filter edges with tag rate-limiting ────────────────────────────────
  const visibleEdgeKinds = new Set(['related']);
  if (filters.visibleNodeTypes.has('studio'))    visibleEdgeKinds.add('studio');
  if (filters.visibleNodeTypes.has('tag'))       visibleEdgeKinds.add('tag');
  if (filters.visibleNodeTypes.has('character')) visibleEdgeKinds.add('character');
  if (filters.visibleNodeTypes.has('staff'))     visibleEdgeKinds.add('staff');

  const filteredEdges = [];
  for (const e of rawGraph.edges) {
    if (!allVisibleIds.has(e.s) || !allVisibleIds.has(e.t)) continue;
    if (!visibleEdgeKinds.has(e.k)) continue;

    // Rate-limit tag edges to prevent thousands of lines per tag node
    if (e.k === 'tag') {
      const tagId = filteredAnimeIds.has(e.s) ? e.t : e.s;
      const count = tagEdgeCount.get(tagId) || 0;
      if (count >= TAG_EDGE_MAX_PER_TAG) continue;
      tagEdgeCount.set(tagId, count + 1);
    }

    filteredEdges.push(e);
  }

  // ── 6. Assign colors ──────────────────────────────────────────────────────
  const allNodes = [...filteredAnime, ...visibleMeta];
  allNodes.forEach(n => {
    n._color = getNodeColor(n, filters.colorBy, nodeById);
  });

  // ── 7. Build force-graph arrays ───────────────────────────────────────────
  const nodes = allNodes.map(n => ({
    id:    n.node_id,
    label: n.title || n.title_en || n.name || '?',
    color: n._color,
    val:   nodeSize(n),
    data:  n,
  }));

  const links = filteredEdges.map(e => ({
    source:       e.s,
    target:       e.t,
    kind:         e.k,
    relationLabel: e.rel || null,
  }));

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

function buildLegend(filteredAnime, colorBy, visibleNodeTypes) {
  const container = document.getElementById('legend-items');
  container.innerHTML = '';

  function addItem(color, label) {
    const div       = document.createElement('div');
    div.className   = 'legend-item';
    div.innerHTML   = `
      <div class="legend-dot" style="background:${color}"></div>
      <span style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${label}</span>`;
    container.appendChild(div);
  }

  // Always show meta node types in legend (fixed colors)
  const metaTypes = [
    ['studio', 'Studios'],
    ['tag', 'Tags'],
    ['character', 'Characters'],
    ['staff', 'Staff'],
  ];

  // ── Anime color section ───────────────────────────────────────────────────
  if (colorBy === 'node_type') {
    addItem('#e8a030', 'Anime');
  } else if (colorBy === 'type') {
    const counts = {};
    filteredAnime.forEach(a => { counts[a.anime_type] = (counts[a.anime_type] || 0) + 1; });
    Object.entries(ANIME_TYPE_COLORS).forEach(([type, col]) => {
      if (counts[type]) addItem(col, `${type} (${counts[type].toLocaleString()})`);
    });
  } else if (colorBy === 'year') {
    const usedBands = new Set(filteredAnime.map(a => yearBandLabel(a.year)));
    YEAR_BANDS.forEach(b => {
      if (usedBands.has(b.label)) addItem(`hsl(${b.hue},70%,55%)`, b.label);
    });
  } else if (colorBy === 'completion') {
    const colors  = window.COMPLETION_STATUS_COLORS || {};
    const labels  = window.COMPLETION_STATUS_LABELS || {};
    const counts  = {};
    filteredAnime.forEach(a => {
      const st = getUserStatusForAnime ? getUserStatusForAnime(a.al_id) : null;
      if (st) counts[st] = (counts[st] || 0) + 1;
    });
    Object.entries(colors).forEach(([st, col]) => {
      if (counts[st]) addItem(col, `${labels[st] || st} (${counts[st].toLocaleString()})`);
    });
    addItem('#555555', 'Not in list');
  }

  // Separator
  if (colorBy !== 'node_type') {
    const sep      = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid rgba(255,255,255,0.08);margin:6px 0;';
    container.appendChild(sep);
  }

  // Meta node legend entries
  metaTypes.forEach(([type, label]) => {
    if (visibleNodeTypes && visibleNodeTypes.has(type)) {
      addItem(META_NODE_COLORS[type], label);
    }
  });
}

// ── CLUSTER COUNTER (anime-only) ──────────────────────────────────────────────

function calculateAnimeClusters(nodes, links) {
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
