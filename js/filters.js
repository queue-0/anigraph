/**
 * filters.js — Anigraph
 * Builds filtered graph data, assigns colors/sizes, builds legend.
 *
 * Virtual "color-category" meta nodes (anime_type, season, year, release_status,
 * completion) are now ACTUALLY CONSTRUCTED here and connected to anime via
 * synthetic edges. They auto-hide when that color mode is active (redundant).
 */

'use strict';

// ── PERFORMANCE CAPS ──────────────────────────────────────────────────────────
const TAG_EDGE_MAX_PER_TAG      = 20000;
const GENRE_EDGE_MAX_PER_GENRE  = 20000;
const STUDIO_EDGE_MAX_PER_STUDIO= 20000;

// ── GENRE TAGS ────────────────────────────────────────────────────────────────
const GENRE_TAGS = new Set([
  "Action","Adventure","Comedy","Ecchi","Fantasy","Horror",
  "Mahou Shoujo","Mecha","Music","Mystery","Psychological",
  "Romance","Sci-Fi","Slice of Life","Sports","Supernatural","Thriller",
]);

// ── META NODE COLORS ──────────────────────────────────────────────────────────
// Defaults — overridden at runtime by window.CONFIGURABLE_COLORS
function getMetaColor(key) {
  return (window.CONFIGURABLE_COLORS || {})[key] || META_NODE_DEFAULTS[key] || '#808080';
}
const META_NODE_DEFAULTS = {
  studio:         '#5eb8ff',
  genre:          '#c882ff',  // distinct violet — was orange (#ffb347)
  tag:            '#5dde9a',
  anime_node:     '#e8a030',  // base anime color
  anime_type:     '#f0a030',
  season_node:    '#88cc44',
  year_node:      '#66aaff',
  status_node:    '#dd88aa',
  completion_node:'#40c080',
};
// Keep META_NODE_COLORS as a proxy that reads from CONFIGURABLE_COLORS
const META_NODE_COLORS = new Proxy(META_NODE_DEFAULTS, {
  get(target, key) { return getMetaColor(key); }
});

// ── ANIME TYPE COLORS ─────────────────────────────────────────────────────────
const ANIME_TYPE_COLORS = {
  TV:      '#f0a030',
  MOVIE:   '#e05050',
  OVA:     '#e080d0',
  ONA:     '#a0d060',
  SPECIAL: '#d06030',
  UNKNOWN: '#606060',
};

// ── SEASON COLORS ─────────────────────────────────────────────────────────────
const SEASON_COLORS = {
  SPRING: '#88cc44',
  SUMMER: '#ff9933',
  FALL:   '#cc5522',
  WINTER: '#66aaff',
};

// ── RELEASE STATUS COLORS / LABELS ────────────────────────────────────────────
const RELEASE_STATUS_COLORS = {
  FINISHED:         '#6688aa',
  RELEASING:        '#44cc66',
  NOT_YET_RELEASED: '#cc9944',
  CANCELLED:        '#cc4444',
  HIATUS:           '#aa66cc',
  UNKNOWN:          '#555555',
};
const RELEASE_STATUS_LABELS = {
  FINISHED:         'Finished',
  RELEASING:        'Airing',
  NOT_YET_RELEASED: 'Not Yet Released',
  CANCELLED:        'Cancelled',
  HIATUS:           'On Hiatus',
  UNKNOWN:          'Unknown',
};

// ── YEAR BANDS ────────────────────────────────────────────────────────────────
const YEAR_BANDS = [
  { max: 1969, label: '≤1969',   hue: 0   },
  { max: 1979, label: '1970s',   hue: 25  },
  { max: 1989, label: '1980s',   hue: 50  },
  { max: 1999, label: '1990s',   hue: 100 },
  { max: 2009, label: '2000s',   hue: 160 },
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

// ── GRADIENT: green(10) → yellow(~7) → red(≤5) ───────────────────────────────
// Scores: 10=green(120°), 7=yellow(60°), 5=orange(30°), ≤0=red(0°)
// Map score 0-10 → hue 0-120, but shift so red starts at 5, not 0
function gradientColor(t) {
  // t is 0–1 where 1=best
  t = Math.max(0, Math.min(1, t));
  // Remap so that t=0.5 (score=5) → hue=0 (red), t=1 (score=10) → hue=120 (green)
  // Below 5 is all red; 5–10 maps to red→green
  const hue = Math.max(0, (t - 0.5) / 0.5) * 120;
  return `hsl(${hue.toFixed(0)},85%,52%)`;
}
function scoreColor(score)      { return score == null ? '#555' : gradientColor(score / 10); }
function durationColor(mins)    { return (!mins || mins <= 0) ? '#555' : gradientColor(Math.min(mins, 2000) / 2000); }
function scoreDeltaColor(delta) { return gradientColor((delta + 5) / 10); }

// ── FILTER STATE READER ───────────────────────────────────────────────────────
function getFilters() {
  const types = new Set(
    [...document.querySelectorAll('#type-checkboxes input:checked')].map(i => i.value)
  );
  const visibleNodeTypes = new Set(
    [...document.querySelectorAll('#node-type-visibility input:checked')].map(i => i.value)
  );
  const releaseStatuses = new Set(
    [...document.querySelectorAll('#release-status-checkboxes input:checked')].map(i => i.value)
  );
  const yearFrom  = parseInt(document.getElementById('year-from').value)   || 0;
  const yearTo    = parseInt(document.getElementById('year-to').value)     || 9999;
  const epMin     = parseInt(document.getElementById('ep-min').value)      || 0;
  const epMax     = parseInt(document.getElementById('ep-max').value)      || 999999;
  const lenMin    = parseFloat(document.getElementById('len-min').value)   || 0;
  const lenMax    = parseFloat(document.getElementById('len-max').value)   || 999999;
  const scoreMin  = parseFloat(document.getElementById('score-min').value) || 0;
  const scoreMax  = parseFloat(document.getElementById('score-max').value);
  const scoreMaxV = isNaN(scoreMax) ? 10 : scoreMax;

  const selTags    = [...document.getElementById('tag-select').selectedOptions].map(o => o.value);
  const selGenres  = [...document.getElementById('genre-select').selectedOptions].map(o => o.value);
  const selStudios = [...document.getElementById('studio-select').selectedOptions].map(o => o.value);

  const search     = document.getElementById('search-input').value.trim().toLowerCase();
  const colorBy    = document.querySelector('input[name="colorby"]:checked')?.value || 'node_type';
  const nodeSizeBy = document.querySelector('input[name="nodeSizeBy"]:checked')?.value || 'default';
  const minClusterSize = parseInt(document.getElementById('min-cluster-size')?.value) || 1;
  const mode       = document.getElementById('mode-select')?.value || 'all';

  const hl = {
    animetype:     document.getElementById('highlight-animetype')?.checked     || false,
    releasestatus: document.getElementById('highlight-releasestatus')?.checked || false,
    year:          document.getElementById('highlight-year')?.checked          || false,
    episodes:      document.getElementById('highlight-episodes')?.checked      || false,
    length:        document.getElementById('highlight-length')?.checked        || false,
    score:         document.getElementById('highlight-score')?.checked         || false,
    genres:        document.getElementById('highlight-genres')?.checked        || false,
    tags:          document.getElementById('highlight-tags')?.checked          || false,
    studios:       document.getElementById('highlight-studios')?.checked       || false,
  };

  return {
    types, visibleNodeTypes, releaseStatuses,
    yearFrom, yearTo, epMin, epMax, lenMin, lenMax,
    scoreMin, scoreMax: scoreMaxV,
    selTags, selGenres, selStudios,
    search, colorBy, nodeSizeBy, minClusterSize, mode,
    highlights: hl,
  };
}

// ── COLOR RESOLVER ────────────────────────────────────────────────────────────
function getNodeColor(node, colorBy, nodeById) {
  if (node._virtualMeta) return node._color;
  if (node.type !== 'anime') return getMetaColor(node.type) || '#808080';

  // Use configurable anime base color
  const animeBase = getMetaColor('anime_node');

  switch (colorBy) {
    case 'type':       return (window.CONFIGURABLE_COLORS?.['type_'+node.anime_type]) || ANIME_TYPE_COLORS[node.anime_type] || '#606060';
    case 'year':       return yearColor(node.year);
    case 'season':     return SEASON_COLORS[node.season] || '#666666';
    case 'score':      return scoreColor(node.score);
    case 'duration':   return durationColor(totalMinutes(node));
    case 'release_status': return RELEASE_STATUS_COLORS[node.release_status || 'UNKNOWN'];
    case 'completion': {
      const st = getUserStatusForAnime ? getUserStatusForAnime(node.al_id) : null;
      return (window.COMPLETION_STATUS_COLORS || {})[st] || '#555555';
    }
    case 'user_score': {
      const us = getUserScoreForAnime ? getUserScoreForAnime(node.al_id) : null;
      return us == null ? '#555555' : scoreColor(us);
    }
    case 'score_delta': {
      const us = getUserScoreForAnime ? getUserScoreForAnime(node.al_id) : null;
      return (us == null || node.score == null) ? '#555555' : scoreDeltaColor(us - node.score);
    }
    default: return animeBase;
  }
}

// ── NODE SIZE ─────────────────────────────────────────────────────────────────
function getNodeSize(node, nodeSizeBy, edgeCounts, maxEdgeCount) {
  if (node._virtualMeta) return 4.5;

  const isAnime = node.type === 'anime';

  if (nodeSizeBy === 'default') {
    if (!isAnime) {
      if (node.type === 'studio') return 6.0;
      if (node.type === 'genre')  return 5.5;
      if (node.type === 'tag')    return 5.0;
      return 5.0;
    }
    return 1.5;
  }

  if (nodeSizeBy === 'edges') {
    const cnt = edgeCounts?.get(node.node_id) || 0;
    const max = maxEdgeCount || 1;
    // Linear percentage scaled to 1–40 range for dramatic difference
    const pct = cnt / max;
    return 1.0 + pct * 45.0;
  }
  if (nodeSizeBy === 'score') {
    const s = isAnime ? node.score : null;
    if (s == null || s <= 0) return 0.5;
    return 0.5 + Math.pow(s / 10, 2) * 25.0;
  }
  if (nodeSizeBy === 'user_score') {
    if (!isAnime) return 0.5;
    const us = getUserScoreForAnime ? getUserScoreForAnime(node.al_id) : null;
    if (us == null) return 0.5;
    return 0.5 + Math.pow(us / 10, 2) * 25.0;
  }
  return 1.5;
}

// ── ANIME FILTER TEST ─────────────────────────────────────────────────────────
function animeFilterResult(a, filters, nodeById) {
  const hl = filters.highlights;
  let shouldHighlight = false;

  function check(passes, isHighlight) {
    if (!passes) {
      if (isHighlight) { shouldHighlight = true; return true; }
      return false;
    }
    return true;
  }

  if (!check(filters.types.has(a.anime_type), hl.animetype)) return 'fail';

  const rs = a.release_status || 'UNKNOWN';
  if (!check(filters.releaseStatuses.size === 0 || filters.releaseStatuses.has(rs), hl.releasestatus)) return 'fail';

  if (a.year) {
    if (!check(a.year >= filters.yearFrom && a.year <= filters.yearTo, hl.year)) return 'fail';
  }

  const eps = a.episodes || 0;
  if (!check(eps >= filters.epMin && eps <= filters.epMax, hl.episodes)) return 'fail';

  const mins = totalMinutes(a);
  if (mins > 0) {
    if (!check(mins >= filters.lenMin && mins <= filters.lenMax, hl.length)) return 'fail';
  }

  if (a.score != null) {
    if (!check(a.score >= filters.scoreMin && a.score <= filters.scoreMax, hl.score)) return 'fail';
  }

  if (filters.selGenres.length > 0) {
    // Check genre_ids (type:'genre' nodes) AND tag_ids whose name is in GENRE_TAGS
    const genreNames = [
      ...(a.genre_ids || []).map(id => nodeById.get(id)?.name),
      ...(a.tag_ids   || []).map(id => {
        const n = nodeById.get(id);
        return (n && GENRE_TAGS.has(n.name)) ? n.name : null;
      }),
    ].filter(Boolean);
    if (!check(filters.selGenres.some(g => genreNames.includes(g)), hl.genres)) return 'fail';
  }

  if (filters.selTags.length > 0) {
    const tagNames = (a.tag_ids || [])
      .map(id => nodeById.get(id)?.name)
      .filter(name => name && !GENRE_TAGS.has(name));
    if (!check(filters.selTags.some(t => tagNames.includes(t)), hl.tags)) return 'fail';
  }

  if (filters.selStudios.length > 0) {
    const studioNames = (a.studio_ids || []).map(id => nodeById.get(id)?.name).filter(Boolean);
    if (!check(filters.selStudios.some(s => studioNames.includes(s)), hl.studios)) return 'fail';
  }

  if (filters.search) {
    const title   = (a.title    || '').toLowerCase();
    const titleEn = (a.title_en || '').toLowerCase();
    if (!title.includes(filters.search) && !titleEn.includes(filters.search)) return 'fail';
  }

  return shouldHighlight ? 'highlight' : 'pass';
}

// ── BUILD GRAPH DATA ──────────────────────────────────────────────────────────
/**
 * Returns { nodes, links, filteredAnime, highlightedAnime, visibleMeta }
 *
 * Virtual "color-category" meta nodes are created here for:
 *   anime_type  → shown when visibleNodeTypes has 'anime_type'  AND colorBy !== 'type'
 *   season_node → shown when visibleNodeTypes has 'season_node' AND colorBy !== 'season'
 *   year_node   → shown when visibleNodeTypes has 'year_node'   AND colorBy !== 'year'
 *   status_node → shown when visibleNodeTypes has 'status_node' AND colorBy !== 'release_status'
 *   completion_node → shown when 'completion_node' checked AND colorBy !== 'completion'
 */
function buildGraphData(rawGraph, filters, nodeById) {
  const activeUserIds = getActiveUserIds ? getActiveUserIds() : null;
  const modeIsUser    = filters.mode === 'user' && activeUserIds !== null;

  // ── 1. Filter anime ───────────────────────────────────────────────────────
  const animeNodes       = rawGraph.nodes.filter(n => n.type === 'anime');
  const filteredAnime    = [];
  const highlightedAnime = [];

  for (const a of animeNodes) {
    if (modeIsUser && !activeUserIds.has(a.al_id)) continue;

    const result = animeFilterResult(a, filters, nodeById);
    if (result === 'fail') continue;
    if (result === 'highlight') highlightedAnime.push(a);
    else filteredAnime.push(a);
  }

  const finalAnime    = filteredAnime;
  const finalHighlight= highlightedAnime;
  const finalAllAnime = [...finalAnime, ...finalHighlight];
  const finalAnimeIds = new Set(finalAllAnime.map(n => n.node_id));
  const highlightIds  = new Set(finalHighlight.map(n => n.node_id));

  const colorBy = filters.colorBy;

  // ── 2. Standard meta node visibility (studio/genre/tag) ───────────────────
  const showStudio = filters.visibleNodeTypes.has('studio');
  const showGenre  = filters.visibleNodeTypes.has('genre');
  const showTag    = filters.visibleNodeTypes.has('tag');

  const explicitStudios = new Set(filters.selStudios);
  const explicitTags    = new Set(filters.selTags);
  const explicitGenres  = new Set(filters.selGenres);

  const tagEdgeCount    = new Map();
  const genreEdgeCount  = new Map();
  const studioEdgeCount = new Map();
  const visibleMetaIds  = new Set();

  for (const e of rawGraph.edges) {
    if (e.k === 'related') continue;

    const sIsAnime = finalAnimeIds.has(e.s);
    const tIsAnime = finalAnimeIds.has(e.t);
    if (sIsAnime === tIsAnime) continue;

    const metaId   = sIsAnime ? e.t : e.s;
    const metaNode = nodeById.get(metaId);
    if (!metaNode || metaNode.type === 'anime') continue;

    const mt = metaNode.type;
    if (mt === 'studio') {
      if (!showStudio) continue;
      if (explicitStudios.size > 0 && !explicitStudios.has(metaNode.name)) continue;
    } else if (mt === 'genre') {
      if (!showGenre) continue;
      if (explicitGenres.size > 0 && !explicitGenres.has(metaNode.name)) continue;
      // Also treat tag nodes with genre names as genre nodes
    } else if (mt === 'tag') {
      // If this tag is a genre name, treat it as genre visibility
      if (GENRE_TAGS.has(metaNode.name)) {
        if (!showGenre) continue;
        if (explicitGenres.size > 0 && !explicitGenres.has(metaNode.name)) continue;
      } else {
        if (!showTag) continue;
        if (explicitTags.size > 0 && !explicitTags.has(metaNode.name)) continue;
      }
    } else {
      continue;
    }

    visibleMetaIds.add(metaId);
  }

  const visibleMeta = rawGraph.nodes.filter(n => visibleMetaIds.has(n.node_id));

  // ── 3. Virtual color-category meta nodes ─────────────────────────────────
  // These are ALWAYS shown when their checkbox is checked (no auto-hide)
  const showTypeNodes       = filters.visibleNodeTypes.has('anime_type');
  const showSeasonNodes     = filters.visibleNodeTypes.has('season_node');
  const showYearNodes       = filters.visibleNodeTypes.has('year_node');
  const showStatusNodes     = filters.visibleNodeTypes.has('status_node');
  const showCompletionNodes = filters.visibleNodeTypes.has('completion_node');

  // Virtual node registry: key → syntheticId
  const virtualNodeMap = new Map();
  const virtualNodes  = [];
  const virtualLinks  = [];
  let   virtualIdSeed = -1; // negative IDs to avoid collision with real node_ids

  function getOrCreateVirtual(key, label, color, metaType) {
    if (!virtualNodeMap.has(key)) {
      const vid = virtualIdSeed--;
      const vnode = {
        node_id:      vid,
        type:         metaType,
        name:         label,
        _virtualMeta: true,
        _color:       color,
      };
      virtualNodeMap.set(key, vid);
      virtualNodes.push(vnode);
    }
    return virtualNodeMap.get(key);
  }

  // Build virtual nodes + links for each anime
  for (const a of finalAllAnime) {
    if (showTypeNodes && a.anime_type) {
      const col = (window.CONFIGURABLE_COLORS?.['type_'+a.anime_type]) || ANIME_TYPE_COLORS[a.anime_type] || '#606060';
      const vid = getOrCreateVirtual(`type_${a.anime_type}`, a.anime_type, col, 'anime_type');
      virtualLinks.push({ source: a.node_id, target: vid, kind: 'anime_type', relationLabel: null });
    }
    if (showSeasonNodes && a.season) {
      const col = SEASON_COLORS[a.season] || '#888888';
      const vid = getOrCreateVirtual(`season_${a.season}`, a.season, col, 'season_node');
      virtualLinks.push({ source: a.node_id, target: vid, kind: 'season_node', relationLabel: null });
    }
    if (showYearNodes && a.year) {
      const band = YEAR_BANDS.find(b => a.year <= b.max) || YEAR_BANDS[YEAR_BANDS.length - 1];
      const col  = `hsl(${band.hue},70%,55%)`;
      const vid  = getOrCreateVirtual(`year_${band.label}`, band.label, col, 'year_node');
      virtualLinks.push({ source: a.node_id, target: vid, kind: 'year_node', relationLabel: null });
    }
    if (showStatusNodes) {
      const rs  = a.release_status || 'UNKNOWN';
      const col = RELEASE_STATUS_COLORS[rs] || '#555555';
      const vid = getOrCreateVirtual(`status_${rs}`, RELEASE_STATUS_LABELS[rs] || rs, col, 'status_node');
      virtualLinks.push({ source: a.node_id, target: vid, kind: 'status_node', relationLabel: null });
    }
    if (showCompletionNodes && window.userListLoaded) {
      const st  = getUserStatusForAnime ? getUserStatusForAnime(a.al_id) : null;
      const key = st || 'NOT_LISTED';
      const col = (window.COMPLETION_STATUS_COLORS || {})[st] || '#555555';
      const lbl = (window.COMPLETION_STATUS_LABELS || {})[st] || 'Not in List';
      const vid = getOrCreateVirtual(`completion_${key}`, lbl, col, 'completion_node');
      virtualLinks.push({ source: a.node_id, target: vid, kind: 'completion_node', relationLabel: null });
    }
  }

  // ── 4. Build edge set from rawGraph ───────────────────────────────────────
  const allVisibleIds = new Set([...finalAnimeIds, ...visibleMetaIds]);
  const edgeDedup     = new Set();
  const filteredEdges = [];

  for (const e of rawGraph.edges) {
    if (!allVisibleIds.has(e.s) || !allVisibleIds.has(e.t)) continue;

    const sNode = nodeById.get(e.s);
    const tNode = nodeById.get(e.t);
    if (!sNode || !tNode) continue;
    if (sNode.type !== 'anime' && tNode.type !== 'anime') continue;

    if (e.k === 'studio'    && !showStudio) continue;
    if (e.k === 'genre'     && !showGenre)  continue;
    if (e.k === 'tag') {
      // tag edges for genre-tagged nodes follow genre visibility
      const metaNode = sNode.type !== 'anime' ? sNode : tNode;
      if (GENRE_TAGS.has(metaNode.name)) {
        if (!showGenre) continue;
      } else {
        if (!showTag) continue;
      }
    }
    if (e.k === 'character' || e.k === 'staff') continue;

    const key = `${Math.min(e.s,e.t)}_${Math.max(e.s,e.t)}_${e.k}`;
    if (edgeDedup.has(key)) continue;
    edgeDedup.add(key);

    if (e.k === 'tag') {
      const id = sNode.type !== 'anime' ? e.s : e.t;
      const c  = tagEdgeCount.get(id) || 0;
      if (c >= TAG_EDGE_MAX_PER_TAG) continue;
      tagEdgeCount.set(id, c + 1);
    }
    if (e.k === 'genre') {
      const id = sNode.type !== 'anime' ? e.s : e.t;
      const c  = genreEdgeCount.get(id) || 0;
      if (c >= GENRE_EDGE_MAX_PER_GENRE) continue;
      genreEdgeCount.set(id, c + 1);
    }
    if (e.k === 'studio') {
      const id = sNode.type !== 'anime' ? e.s : e.t;
      const c  = studioEdgeCount.get(id) || 0;
      if (c >= STUDIO_EDGE_MAX_PER_STUDIO) continue;
      studioEdgeCount.set(id, c + 1);
    }

    filteredEdges.push(e);
  }

  // ── 5. Edge count map for sizing ──────────────────────────────────────────
  const edgeCounts = new Map();
  const allEdges   = [...filteredEdges, ...virtualLinks];
  for (const e of allEdges) {
    const s = typeof e.source === 'number' ? e.source : e.s;
    const t = typeof e.target === 'number' ? e.target : e.t;
    edgeCounts.set(s, (edgeCounts.get(s) || 0) + 1);
    edgeCounts.set(t, (edgeCounts.get(t) || 0) + 1);
  }
  const maxEdgeCount = Math.max(1, ...edgeCounts.values());

  // ── 6. Assign colors & sizes ──────────────────────────────────────────────
  const allRealNodes = [...finalAnime, ...finalHighlight, ...visibleMeta];
  for (const n of allRealNodes) {
    n._color  = getNodeColor(n, colorBy, nodeById);
    n._dimmed = highlightIds.has(n.node_id);
    n._size   = getNodeSize(n, filters.nodeSizeBy, edgeCounts, maxEdgeCount);
  }
  for (const vn of virtualNodes) {
    vn._dimmed = false;
    vn._size   = getNodeSize(vn, filters.nodeSizeBy, edgeCounts, maxEdgeCount);
  }

  // ── 7. Build force-graph node/link arrays ─────────────────────────────────
  const nodes = [
    ...allRealNodes.map(n => ({
      id:     n.node_id,
      label:  n.title || n.title_en || n.name || '?',
      color:  n._color,
      dimmed: n._dimmed,
      val:    n._size,
      data:   n,
    })),
    ...virtualNodes.map(vn => ({
      id:     vn.node_id,
      label:  vn.name,
      color:  vn._color,
      dimmed: false,
      val:    vn._size,
      data:   vn,
    })),
  ];

  const rawLinks = filteredEdges.map(e => ({
    source:        e.s,
    target:        e.t,
    kind:          e.k,
    relationLabel: e.rel || null,
  }));
  const links = [...rawLinks, ...virtualLinks];

  return {
    nodes, links,
    filteredAnime:    finalAnime,
    highlightedAnime: finalHighlight,
    visibleMeta: [...visibleMeta, ...virtualNodes],
  };
}

// ── CLUSTER HELPERS ───────────────────────────────────────────────────────────
function _buildAnimeAdj(nodes, links) {
  const animeIds = new Set(nodes.filter(n => n.data?.type === 'anime').map(n => n.id));
  const adj = new Map();
  animeIds.forEach(id => adj.set(id, []));
  links.forEach(l => {
    if (l.kind !== 'related') return;
    const src = typeof l.source === 'object' ? l.source.id : l.source;
    const tgt = typeof l.target === 'object' ? l.target.id : l.target;
    if (animeIds.has(src) && animeIds.has(tgt)) {
      adj.get(src).push(tgt);
      adj.get(tgt).push(src);
    }
  });
  return { animeIds, adj };
}

function calculateAnimeClusters(nodes, links) {
  const { animeIds, adj } = _buildAnimeAdj(nodes, links);
  if (animeIds.size === 0) return { count: 0, largest: 0, largestClusterIds: new Set() };

  const visited = new Set();
  let count = 0, largest = 0;
  let largestClusterIds = new Set();

  animeIds.forEach(id => {
    if (visited.has(id)) return;
    count++;
    const clusterIds = new Set();
    const stack = [id];
    visited.add(id);
    while (stack.length) {
      const cur = stack.pop();
      clusterIds.add(cur);
      for (const nb of (adj.get(cur) || [])) {
        if (!visited.has(nb)) { visited.add(nb); stack.push(nb); }
      }
    }
    if (clusterIds.size > largest) {
      largest = clusterIds.size;
      largestClusterIds = new Set(clusterIds); // clone
    }
  });
  return { count, largest, largestClusterIds };
}

function countClustersOfMinSize(nodes, links, minSize) {
  const { animeIds, adj } = _buildAnimeAdj(nodes, links);
  if (minSize <= 1) return animeIds.size > 0 ? calculateAnimeClusters(nodes, links).count : 0;

  const visited = new Set();
  let filtered = 0;
  animeIds.forEach(id => {
    if (visited.has(id)) return;
    let size = 0;
    const stack = [id];
    visited.add(id);
    while (stack.length) {
      const cur = stack.pop();
      size++;
      for (const nb of (adj.get(cur) || [])) {
        if (!visited.has(nb)) { visited.add(nb); stack.push(nb); }
      }
    }
    if (size >= minSize) filtered++;
  });
  return filtered;
}

/**
 * BFS longest chain — double-BFS to find true diameter, returns {length, ids}.
 * ids is a Set of ForceGraph node IDs along the longest path.
 */
function calculateLongestChain(nodes, links) {
  const { animeIds, adj } = _buildAnimeAdj(nodes, links);
  if (animeIds.size === 0) return { length: 0, ids: new Set() };

  // Helper: BFS from start, returns {dist Map, farthestNode, maxDist}
  function bfs(start) {
    const dist = new Map([[start, 0]]);
    const prev = new Map([[start, null]]); // parent tracking
    const queue = [start];
    let qi = 0, farthest = start, maxDist = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      const d   = dist.get(cur);
      for (const nb of (adj.get(cur) || [])) {
        if (!dist.has(nb)) {
          dist.set(nb, d + 1);
          prev.set(nb, cur);
          queue.push(nb);
          if (d + 1 > maxDist) { maxDist = d + 1; farthest = nb; }
        }
      }
    }
    return { dist, prev, farthest, maxDist };
  }

  // Sample to find a good endpoint u
  const ids = [...animeIds];
  const sampleStep = Math.max(1, Math.ceil(ids.length / 200));
  const sample = ids.filter((_, i) => i % sampleStep === 0);

  let bestEnd = ids[0];
  let bestDist = 0;
  for (const s of sample) {
    const { farthest, maxDist } = bfs(s);
    if (maxDist > bestDist) { bestDist = maxDist; bestEnd = farthest; }
  }

  // BFS from bestEnd to find the true far end v and trace path
  const { prev, farthest: v, maxDist: chainLen } = bfs(bestEnd);

  // Trace path from v back to bestEnd
  const chainIds = new Set();
  if (chainLen > 0) {
    let cur = v;
    while (cur !== null && cur !== undefined) {
      chainIds.add(cur);
      cur = prev.get(cur);
      if (cur === undefined) break;
    }
  } else {
    chainIds.add(bestEnd);
  }

  return { length: chainLen, ids: chainIds };
}

// ── LEGEND BUILDER ────────────────────────────────────────────────────────────
function buildLegend(filteredAnime, colorBy, visibleNodeTypes, visibleMetaForLegend, highlightedAnime) {
  const container = document.getElementById('legend-items');
  container.innerHTML = '';
  const allAnime = [...filteredAnime, ...(highlightedAnime || [])];

  function addItem(color, label, legendKey, legendVal) {
    const div = document.createElement('div');
    div.className = 'legend-item';
    if (legendKey) {
      div.dataset.legendKey = legendKey;
      div.dataset.legendVal = legendVal || '';
      div.style.cursor = 'pointer';
      div.title = 'Click to highlight';
    }
    div.innerHTML = `<div class="legend-dot" style="background:${color}"></div>
      <span style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${label}</span>`;
    container.appendChild(div);
  }

  function addGradientBar(loLabel, hiLabel, c1, c2, c3) {
    const grad = c1 ? `linear-gradient(90deg,${c1},${c2||c1},${c3||c2||c1})` :
      'linear-gradient(90deg,hsl(0,85%,52%),hsl(30,85%,52%),hsl(120,85%,52%))';
    const div = document.createElement('div');
    div.className = 'legend-gradient';
    div.innerHTML = `
      <div class="legend-grad-bar" style="background:${grad}"></div>
      <div class="legend-grad-labels"><span>${loLabel}</span><span>${hiLabel}</span></div>`;
    container.appendChild(div);
  }

  const total = allAnime.length;
  // Show anime node base color when no specific color mode
  if (!['type','year','season','release_status','score','duration','completion','user_score','score_delta'].includes(colorBy)) {
    addItem(getMetaColor('anime_node'), `Anime (${total.toLocaleString()})`);
  }

  if (colorBy === 'type') {
    const counts = {};
    allAnime.forEach(a => { counts[a.anime_type] = (counts[a.anime_type] || 0) + 1; });
    Object.entries(ANIME_TYPE_COLORS).forEach(([type, col]) => {
      const c = (window.CONFIGURABLE_COLORS?.['type_'+type]) || col;
      if (counts[type]) addItem(c, `${type} (${counts[type].toLocaleString()})`, 'anime_type', type);
    });
  } else if (colorBy === 'year') {
    const bandCounts = {};
    allAnime.forEach(a => { const lbl = yearBandLabel(a.year); bandCounts[lbl] = (bandCounts[lbl]||0)+1; });
    YEAR_BANDS.forEach(b => {
      if (bandCounts[b.label]) addItem(`hsl(${b.hue},70%,55%)`, `${b.label} (${bandCounts[b.label].toLocaleString()})`, 'year_band', b.label);
    });
  } else if (colorBy === 'season') {
    const counts = {};
    allAnime.forEach(a => { const k = a.season||'Unknown'; counts[k]=(counts[k]||0)+1; });
    Object.entries(SEASON_COLORS).forEach(([s, col]) => {
      if (counts[s]) addItem(col, `${s} (${counts[s].toLocaleString()})`, 'season', s);
    });
    if (counts['Unknown']) addItem('#666', `Unknown (${counts['Unknown'].toLocaleString()})`, 'season', 'Unknown');
  } else if (colorBy === 'release_status') {
    const counts = {};
    allAnime.forEach(a => { const k = a.release_status||'UNKNOWN'; counts[k]=(counts[k]||0)+1; });
    Object.entries(RELEASE_STATUS_COLORS).forEach(([st, col]) => {
      if (counts[st]) addItem(col, `${RELEASE_STATUS_LABELS[st]||st} (${counts[st].toLocaleString()})`, 'release_status', st);
    });
  } else if (colorBy === 'score') {
    addGradientBar('≤5 (low)', '10 (high)', 'hsl(0,85%,52%)', 'hsl(60,85%,52%)', 'hsl(120,85%,52%)');
  } else if (colorBy === 'duration') {
    addGradientBar('Short', 'Long (≥2000 min)', 'hsl(0,85%,52%)', 'hsl(60,85%,52%)', 'hsl(120,85%,52%)');
  } else if (colorBy === 'completion') {
    const colors = window.COMPLETION_STATUS_COLORS || {};
    const labels = window.COMPLETION_STATUS_LABELS || {};
    const counts = {};
    let notInList = 0;
    allAnime.forEach(a => {
      const st = getUserStatusForAnime ? getUserStatusForAnime(a.al_id) : null;
      if (st) counts[st]=(counts[st]||0)+1; else notInList++;
    });
    Object.entries(colors).forEach(([st, col]) => {
      if (counts[st]) addItem(col, `${labels[st]||st} (${counts[st].toLocaleString()})`, 'completion', st);
    });
    if (notInList > 0) addItem('#555', `Not in list (${notInList.toLocaleString()})`);
  } else if (colorBy === 'user_score') {
    addGradientBar('≤5 (low)', '10 (high)', 'hsl(0,85%,52%)', 'hsl(60,85%,52%)', 'hsl(120,85%,52%)');
  } else if (colorBy === 'score_delta') {
    addGradientBar('Much lower', 'Much higher', 'hsl(0,85%,52%)', 'hsl(60,85%,52%)', 'hsl(120,85%,52%)');
  }

  // ── Separator ─────────────────────────────────────────────────────────────
  const sep = document.createElement('div');
  sep.style.cssText = 'border-top:1px solid rgba(255,255,255,0.08);margin:6px 0;';
  container.appendChild(sep);

  // ── Standard meta node types ──────────────────────────────────────────────
  const metaCounts = {};
  if (visibleMetaForLegend) {
    visibleMetaForLegend.forEach(n => { metaCounts[n.type]=(metaCounts[n.type]||0)+1; });
  }
  [
    ['studio',          'Studios',        'meta_type', 'studio'],
    ['genre',           'Genres',         'meta_type', 'genre'],
    ['tag',             'Tags',           'meta_type', 'tag'],
    ['anime_type',      'Anime Types',    'meta_type', 'anime_type'],
    ['season_node',     'Seasons',        'meta_type', 'season_node'],
    ['year_node',       'Year Bands',     'meta_type', 'year_node'],
    ['status_node',     'Airing Status',  'meta_type', 'status_node'],
    ['completion_node', 'List Status',    'meta_type', 'completion_node'],
  ].forEach(([type, label, lk, lv]) => {
    const cnt = metaCounts[type] || 0;
    if (cnt > 0) {
      addItem(META_NODE_COLORS[type] || '#808080', `${label} (${cnt})`, lk, lv);
    } else if (['studio','genre','tag'].includes(type) && visibleNodeTypes.has(type)) {
      addItem(META_NODE_COLORS[type], label, lk, lv);
    }
  });
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function totalMinutes(anime) {
  if (!anime.duration) return 0;
  return ((anime.episodes || 1) * anime.duration) / 60;
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────
window.META_NODE_COLORS        = META_NODE_COLORS;
window.META_NODE_DEFAULTS      = META_NODE_DEFAULTS;
window.getMetaColor            = getMetaColor;
window.ANIME_TYPE_COLORS       = ANIME_TYPE_COLORS;
window.SEASON_COLORS           = SEASON_COLORS;
window.RELEASE_STATUS_COLORS   = RELEASE_STATUS_COLORS;
window.RELEASE_STATUS_LABELS   = RELEASE_STATUS_LABELS;
window.YEAR_BANDS              = YEAR_BANDS;
window.gradientColor           = gradientColor;
window.totalMinutes            = totalMinutes;
window.GENRE_TAGS              = GENRE_TAGS;
window.countClustersOfMinSize  = countClustersOfMinSize;
window.calculateAnimeClusters  = calculateAnimeClusters;
window.calculateLongestChain   = calculateLongestChain;
