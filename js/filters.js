/**
 * filters.js
 * ----------
 * Reads filter state from the sidebar, builds filtered/highlighted graph data.
 *
 * Key behaviours:
 *  - Genre is extracted from tags client-side (GENRE_TAGS set matches slim-database.py)
 *  - "Color category" meta nodes: type/season/year/release_status/completion each have
 *    virtual meta nodes that appear in the graph and auto-hide when that color is selected
 *  - Highlight mode dims non-matching nodes but keeps them in the legend
 *  - minClusterSize only affects the stat display, NOT the rendered data
 *  - Mode filter (all vs user) correctly gates anime
 *  - release_status comes from node.release_status field (set by offline DB)
 *  - No meta↔meta edges; full deduplication
 *  - Node size: when non-default, meta nodes use same calc as anime
 *  - Performance: aggressive edge caps, fast Set-based lookups
 */

'use strict';

// ── PERFORMANCE CAPS ─────────────────────────────────────────────────────────
const TAG_EDGE_MAX_PER_TAG     = 20000;   // reduced for perf
const GENRE_EDGE_MAX_PER_GENRE = 20000;
const STUDIO_EDGE_MAX_PER_STUDIO = 20000;

// ── GENRE TAGS (must match slim-database.py GENRE_TAGS) ──────────────────────
const GENRE_TAGS = new Set([
  "Action","Adventure","Comedy","Ecchi","Fantasy","Horror",
  "Mahou Shoujo","Mecha","Music","Mystery","Psychological",
  "Romance","Sci-Fi","Slice of Life","Sports","Supernatural","Thriller",
]);

// ── FIXED META NODE COLORS ────────────────────────────────────────────────────
const META_NODE_COLORS = {
  studio:         '#5eb8ff',  // sky blue
  genre:          '#ffb347',  // orange
  tag:            '#5dde9a',  // mint green
  // character:   '#ff7eb3',  // commented out
  // staff:       '#c09cff',  // commented out
  // Color-category virtual meta nodes:
  anime_type:     '#f0a030',  // amber (matches TV colour approx)
  season_node:    '#88cc44',  // spring green
  year_node:      '#66aaff',  // year blue
  status_node:    '#dd88aa',  // muted rose
  completion_node:'#40c080',  // list green
};

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

// ── RELEASE STATUS COLORS ─────────────────────────────────────────────────────
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

// ── COUNTRY (commented out — data not in offline DB) ─────────────────────────
// const COUNTRY_COLORS = { JP:'#e8483c', CN:'#f0b030', KR:'#4488cc', ... };
// const COUNTRY_LABELS = { JP:'Japan', CN:'China', KR:'Korea', ... };

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

// ── GRADIENT (for score, duration, user score, score delta) ──────────────────
/** Map 0–1 to blue(0)→green→yellow→red(1) */
function gradientColor(t) {
  t = Math.max(0, Math.min(1, t));
  const hue = (1 - t) * 240;
  return `hsl(${hue.toFixed(0)},80%,55%)`;
}
function gradientBar(label, lo, mid, hi) {
  // Returns an SVG gradient bar for the legend
  return { isGradient: true, label, lo, mid, hi };
}
function scoreColor(score)      { return score  == null ? '#555' : gradientColor(score / 10); }
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

  // Country — commented out
  // const selCountries = new Set([...document.querySelectorAll('#country-checkboxes input:checked')].map(i=>i.value));

  const search     = document.getElementById('search-input').value.trim().toLowerCase();
  const colorBy    = document.querySelector('input[name="colorby"]:checked')?.value || 'node_type';
  const nodeSizeBy = document.querySelector('input[name="nodeSizeBy"]:checked')?.value || 'default';
  const minClusterSize = parseInt(document.getElementById('min-cluster-size')?.value) || 1;
  const mode       = document.getElementById('mode-select')?.value || 'all';

  // Highlight flags
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
    // country:    document.getElementById('highlight-country')?.checked       || false,
  };

  return {
    types, visibleNodeTypes, releaseStatuses,
    yearFrom, yearTo, epMin, epMax, lenMin, lenMax,
    scoreMin, scoreMax: scoreMaxV,
    selTags, selGenres, selStudios,
    // selCountries,
    search, colorBy, nodeSizeBy, minClusterSize, mode,
    highlights: hl,
  };
}

// ── COLOR RESOLVER ────────────────────────────────────────────────────────────
function getNodeColor(node, colorBy, nodeById) {
  // Virtual meta nodes for color categories — always use their category color
  if (node._virtualMeta) return node._color;

  if (node.type !== 'anime') return META_NODE_COLORS[node.type] || '#808080';

  switch (colorBy) {
    case 'node_type':  return '#e8a030';
    case 'type':       return ANIME_TYPE_COLORS[node.anime_type] || '#606060';
    case 'year':       return yearColor(node.year);
    case 'season':     return SEASON_COLORS[node.season] || '#666666';
    case 'score':      return scoreColor(node.score);
    case 'duration':   return durationColor(totalMinutes(node));
    case 'release_status': return RELEASE_STATUS_COLORS[node.release_status || 'UNKNOWN'];
    // case 'country': return COUNTRY_COLORS[node.country||'??']||'#606060';
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
    default: return '#e8a030';
  }
}

// ── NODE SIZE ─────────────────────────────────────────────────────────────────
function getNodeSize(node, nodeSizeBy, edgeCounts) {
  // Virtual meta nodes: medium-fixed size regardless of sizing mode
  if (node._virtualMeta) return 3.0;

  const isAnime = node.type === 'anime';

  if (nodeSizeBy === 'default') {
    if (!isAnime) {
      // meta nodes always larger than default anime
      if (node.type === 'studio') return 4.0;
      if (node.type === 'genre')  return 3.5;
      if (node.type === 'tag')    return 3.0;
      return 3.0;
    }
    return 1.5;  // uniform anime
  }

  // For non-default sizing: apply same calc to both anime and meta
  if (nodeSizeBy === 'edges') {
    const cnt = edgeCounts?.get(node.node_id) || 0;
    return Math.max(0.8, Math.log2(cnt + 2) * 1.6);
  }
  if (nodeSizeBy === 'score') {
    const s = isAnime ? node.score : null;
    if (!s) return 0.8;
    return Math.max(0.5, (s / 10) * 5);
  }
  if (nodeSizeBy === 'user_score') {
    if (!isAnime) return 0.8;
    const us = getUserScoreForAnime ? getUserScoreForAnime(node.al_id) : null;
    if (us == null) return 0.8;
    return Math.max(0.5, (us / 10) * 5);
  }
  return 1.5;
}

// ── ANIME FILTER TEST ─────────────────────────────────────────────────────────
/**
 * Returns: 'pass' | 'highlight' | 'fail'
 * 'highlight' = include but dimmed (highlight mode)
 */
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

  // Country — commented out
  // const country = a.country || '??';
  // if (filters.selCountries.size > 0) {
  //   if (!check(filters.selCountries.has(country), hl.country)) return 'fail';
  // }

  if (filters.selGenres.length > 0) {
    const genreNames = (a.genre_ids || []).map(id => nodeById.get(id)?.name).filter(Boolean);
    if (!check(filters.selGenres.some(g => genreNames.includes(g)), hl.genres)) return 'fail';
  }

  if (filters.selTags.length > 0) {
    const tagNames = (a.tag_ids || []).map(id => nodeById.get(id)?.name).filter(Boolean);
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
function buildGraphData(rawGraph, filters, nodeById) {
  const activeUserIds = getActiveUserIds ? getActiveUserIds() : null;
  const modeIsUser    = filters.mode === 'user' && activeUserIds !== null;

  // ── 1. Filter anime ───────────────────────────────────────────────────────
  const animeNodes      = rawGraph.nodes.filter(n => n.type === 'anime');
  const filteredAnime   = [];
  const highlightedAnime = [];

  for (const a of animeNodes) {
    // Mode gate: user mode → only show list anime; list loaded → respect active IDs
    if (modeIsUser) {
      if (!activeUserIds.has(a.al_id)) continue;
    } else if (activeUserIds !== null) {
      if (!activeUserIds.has(a.al_id)) continue;
    }

    const result = animeFilterResult(a, filters, nodeById);
    if (result === 'fail') continue;
    if (result === 'highlight') highlightedAnime.push(a);
    else filteredAnime.push(a);
  }

  const finalAnime     = filteredAnime;
  const finalHighlight = highlightedAnime;
  const finalAllAnime  = [...finalAnime, ...finalHighlight];
  const finalAnimeIds  = new Set(finalAllAnime.map(n => n.node_id));
  const highlightIds   = new Set(finalHighlight.map(n => n.node_id));

  // ── 2. Meta node visibility ───────────────────────────────────────────────
  const explicitStudios = new Set(filters.selStudios);
  const explicitTags    = new Set(filters.selTags);
  const explicitGenres  = new Set(filters.selGenres);

  // Which standard meta types are visible?
  const showStudio = filters.visibleNodeTypes.has('studio');
  const showGenre  = filters.visibleNodeTypes.has('genre');
  const showTag    = filters.visibleNodeTypes.has('tag');

  // Color-category meta types: auto-hide when their color is active
  // These are toggled in the node-type-visibility section by synthetic values
  const colorBy = filters.colorBy;
  const showTypeNodes       = filters.visibleNodeTypes.has('anime_type')  && colorBy !== 'type';
  const showSeasonNodes     = filters.visibleNodeTypes.has('season_node') && colorBy !== 'season';
  const showYearNodes       = filters.visibleNodeTypes.has('year_node')   && colorBy !== 'year';
  const showStatusNodes     = filters.visibleNodeTypes.has('status_node') && colorBy !== 'release_status';
  const showCompletionNodes = filters.visibleNodeTypes.has('completion_node') && colorBy !== 'completion';

  // Edge counters for rate limiting
  const tagEdgeCount    = new Map();
  const genreEdgeCount  = new Map();
  const studioEdgeCount = new Map();
  const visibleMetaIds  = new Set();

  // Single pass over edges to find visible meta IDs
  for (const e of rawGraph.edges) {
    if (e.k === 'related') continue;  // skip anime↔anime in this pass

    const sIsAnime = finalAnimeIds.has(e.s);
    const tIsAnime = finalAnimeIds.has(e.t);
    if (sIsAnime === tIsAnime) continue;  // both meta or both anime (meta↔meta skipped)

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
    } else if (mt === 'tag') {
      if (!showTag) continue;
      if (explicitTags.size > 0 && !explicitTags.has(metaNode.name)) continue;
    } else {
      continue;  // character/staff — not currently enabled
    }

    visibleMetaIds.add(metaId);
  }

  const visibleMeta   = rawGraph.nodes.filter(n => visibleMetaIds.has(n.node_id));
  const allVisibleIds = new Set([...finalAnimeIds, ...visibleMetaIds]);

  // ── 3. Build edge set ─────────────────────────────────────────────────────
  const edgeDedup     = new Set();
  const filteredEdges = [];

  for (const e of rawGraph.edges) {
    if (!allVisibleIds.has(e.s) || !allVisibleIds.has(e.t)) continue;

    // No meta↔meta
    const sNode = nodeById.get(e.s);
    const tNode = nodeById.get(e.t);
    if (!sNode || !tNode) continue;
    if (sNode.type !== 'anime' && tNode.type !== 'anime') continue;

    // Visibility gate by kind
    if (e.k === 'studio'    && !showStudio) continue;
    if (e.k === 'genre'     && !showGenre)  continue;
    if (e.k === 'tag'       && !showTag)    continue;
    if (e.k === 'character' || e.k === 'staff') continue;  // disabled

    // Dedup
    const key = `${Math.min(e.s,e.t)}_${Math.max(e.s,e.t)}_${e.k}`;
    if (edgeDedup.has(key)) continue;
    edgeDedup.add(key);

    // Rate-limit hub edges
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

  // ── 4. Edge count map for sizing ──────────────────────────────────────────
  const edgeCounts = new Map();
  for (const e of filteredEdges) {
    edgeCounts.set(e.s, (edgeCounts.get(e.s) || 0) + 1);
    edgeCounts.set(e.t, (edgeCounts.get(e.t) || 0) + 1);
  }

  // ── 5. Assign colors & sizes to real nodes ────────────────────────────────
  const allRealNodes = [...finalAnime, ...finalHighlight, ...visibleMeta];
  for (const n of allRealNodes) {
    n._color  = getNodeColor(n, colorBy, nodeById);
    n._dimmed = highlightIds.has(n.node_id);
    n._size   = getNodeSize(n, filters.nodeSizeBy, edgeCounts);
  }

  // ── 6. Build force-graph node/link arrays ─────────────────────────────────
  const nodes = allRealNodes.map(n => ({
    id:     n.node_id,
    label:  n.title || n.title_en || n.name || '?',
    color:  n._color,
    dimmed: n._dimmed,
    val:    n._size,
    data:   n,
  }));

  const links = filteredEdges.map(e => ({
    source:        e.s,
    target:        e.t,
    kind:          e.k,
    relationLabel: e.rel || null,
  }));

  return {
    nodes, links,
    filteredAnime:   finalAnime,
    highlightedAnime: finalHighlight,
    visibleMeta,
  };
}

// ── CLUSTER HELPERS ───────────────────────────────────────────────────────────
function calculateAnimeClusters(nodes, links) {
  const animeIds = new Set(nodes.filter(n => n.data?.type === 'anime').map(n => n.id));
  if (animeIds.size === 0) return { count: 0, largest: 0 };

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

  const visited = new Set();
  let count = 0, largest = 0;
  animeIds.forEach(id => {
    if (visited.has(id)) return;
    count++;
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
    if (size > largest) largest = size;
  });
  return { count, largest };
}

/** Clusters of at least minSize — for stat display only, does NOT filter data */
function countClustersOfMinSize(nodes, links, minSize) {
  const { count, largest } = calculateAnimeClusters(nodes, links);
  if (minSize <= 1) return count;

  // Re-run with size filter for the count stat
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

/** BFS longest chain — sampled for performance */
function calculateLongestChain(nodes, links) {
  const animeIds = new Set(nodes.filter(n => n.data?.type === 'anime').map(n => n.id));
  if (animeIds.size === 0) return 0;

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

  const ids    = [...animeIds];
  const sample = ids.length > 150
    ? ids.filter((_, i) => i % Math.ceil(ids.length / 150) === 0)
    : ids;

  let longest = 0;
  for (const start of sample) {
    const dist  = new Map([[start, 0]]);
    const queue = [start];
    let maxDist = 0;
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      const d   = dist.get(cur);
      for (const nb of (adj.get(cur) || [])) {
        if (!dist.has(nb)) {
          dist.set(nb, d + 1);
          if (d + 1 > maxDist) maxDist = d + 1;
          queue.push(nb);
        }
      }
    }
    if (maxDist > longest) longest = maxDist;
  }
  return longest;
}

// ── LEGEND BUILDER ────────────────────────────────────────────────────────────
function buildLegend(filteredAnime, colorBy, visibleNodeTypes, visibleMetaForLegend, highlightedAnime) {
  const container = document.getElementById('legend-items');
  container.innerHTML = '';

  // allAnime includes highlighted — legend always shows full picture
  const allAnime = [...filteredAnime, ...(highlightedAnime || [])];

  function addItem(color, label, legendKey, legendVal) {
    const div = document.createElement('div');
    div.className = 'legend-item';
    if (legendKey) {
      div.dataset.legendKey = legendKey;
      div.dataset.legendVal = legendVal;
      div.style.cursor = 'pointer';
      div.title = 'Click to highlight';
    }
    div.innerHTML = `
      <div class="legend-dot" style="background:${color}"></div>
      <span style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${label}</span>`;
    container.appendChild(div);
  }

  function addGradientBar(loLabel, hiLabel) {
    const div = document.createElement('div');
    div.className = 'legend-gradient';
    div.innerHTML = `
      <div class="legend-grad-bar"></div>
      <div class="legend-grad-labels"><span>${loLabel}</span><span>${hiLabel}</span></div>`;
    container.appendChild(div);
  }

  const total = allAnime.length;

  // ── Anime color section ───────────────────────────────────────────────────
  if (colorBy === 'node_type') {
    addItem('#e8a030', `Anime (${total.toLocaleString()})`, 'node_type', 'anime');

  } else if (colorBy === 'type') {
    const counts = {};
    allAnime.forEach(a => { counts[a.anime_type] = (counts[a.anime_type] || 0) + 1; });
    Object.entries(ANIME_TYPE_COLORS).forEach(([type, col]) => {
      if (counts[type]) addItem(col, `${type} (${counts[type].toLocaleString()})`, 'anime_type', type);
    });

  } else if (colorBy === 'year') {
    const bandCounts = {};
    allAnime.forEach(a => {
      const lbl = yearBandLabel(a.year);
      bandCounts[lbl] = (bandCounts[lbl] || 0) + 1;
    });
    YEAR_BANDS.forEach(b => {
      if (bandCounts[b.label]) {
        addItem(`hsl(${b.hue},70%,55%)`, `${b.label} (${bandCounts[b.label].toLocaleString()})`, 'year_band', b.label);
      }
    });

  } else if (colorBy === 'season') {
    const counts = {};
    allAnime.forEach(a => { const k = a.season || 'Unknown'; counts[k] = (counts[k]||0)+1; });
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
    addGradientBar('0 (low)', '10 (high)');

  } else if (colorBy === 'duration') {
    addGradientBar('Short', 'Long (≥2000 min)');

  } else if (colorBy === 'completion') {
    const colors = window.COMPLETION_STATUS_COLORS || {};
    const labels = window.COMPLETION_STATUS_LABELS || {};
    const counts = {};
    let notInList = 0;
    allAnime.forEach(a => {
      const st = getUserStatusForAnime ? getUserStatusForAnime(a.al_id) : null;
      if (st) counts[st] = (counts[st]||0)+1;
      else notInList++;
    });
    Object.entries(colors).forEach(([st, col]) => {
      if (counts[st]) addItem(col, `${labels[st]||st} (${counts[st].toLocaleString()})`, 'completion', st);
    });
    if (notInList > 0) addItem('#555', `Not in list (${notInList.toLocaleString()})`);

  } else if (colorBy === 'user_score') {
    addGradientBar('0 (low)', '10 (high)');
  } else if (colorBy === 'score_delta') {
    addGradientBar('Much lower', 'Much higher');
  }

  // ── Separator ─────────────────────────────────────────────────────────────
  const sep = document.createElement('div');
  sep.style.cssText = 'border-top:1px solid rgba(255,255,255,0.08);margin:6px 0;';
  container.appendChild(sep);

  // ── Standard meta node types ──────────────────────────────────────────────
  const metaCounts = {};
  if (visibleMetaForLegend) {
    visibleMetaForLegend.forEach(n => { metaCounts[n.type] = (metaCounts[n.type]||0)+1; });
  }
  [['studio','Studios'],['genre','Genres'],['tag','Tags']].forEach(([type, label]) => {
    if (visibleNodeTypes.has(type)) {
      const cnt = metaCounts[type] || 0;
      addItem(META_NODE_COLORS[type], cnt > 0 ? `${label} (${cnt.toLocaleString()})` : label, 'meta_type', type);
    }
  });

  // CHARACTER / STAFF — commented out
  // [['character','Characters'],['staff','Staff']].forEach(...)
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function totalMinutes(anime) {
  if (!anime.duration) return 0;
  return ((anime.episodes || 1) * anime.duration) / 60;
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────
window.META_NODE_COLORS       = META_NODE_COLORS;
window.ANIME_TYPE_COLORS      = ANIME_TYPE_COLORS;
window.SEASON_COLORS          = SEASON_COLORS;
window.RELEASE_STATUS_COLORS  = RELEASE_STATUS_COLORS;
window.RELEASE_STATUS_LABELS  = RELEASE_STATUS_LABELS;
window.YEAR_BANDS             = YEAR_BANDS;
window.gradientColor          = gradientColor;
window.totalMinutes           = totalMinutes;
window.GENRE_TAGS             = GENRE_TAGS;
window.countClustersOfMinSize = countClustersOfMinSize;
// window.COUNTRY_COLORS = COUNTRY_COLORS;   // commented out
// window.COUNTRY_LABELS = COUNTRY_LABELS;   // commented out
